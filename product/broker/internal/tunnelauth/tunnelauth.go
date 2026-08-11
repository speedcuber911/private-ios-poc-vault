// Package tunnelauth implements the spike's tunnel-registration handshake:
// the broker sends a random challenge, the node proves possession of its
// ed25519 node key by signing (domain-separator || node-id || challenge).
//
// Handshake messages are 4-byte big-endian length-prefixed JSON documents,
// exchanged before the mux takes over the connection:
//
//	broker -> node: {"v":1,"challenge":"<base64>"}
//	node -> broker: {"v":1,"node_id":"<id>","sig":"<base64>"}
//	broker -> node: {"v":1,"ok":true}            (or {"ok":false,"error":...})
package tunnelauth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

const (
	// Version is the handshake wire version.
	Version = 1
	// signatureContext domain-separates tunnel-auth signatures from any other
	// use of the node key.
	signatureContext = "relay-tunnel-auth-v1"

	challengeSize   = 32
	maxAuthMsgBytes = 4 << 10
	handshakeWindow = 10 * time.Second
)

type challengeMsg struct {
	V         int    `json:"v"`
	Challenge string `json:"challenge"`
}

type responseMsg struct {
	V      int    `json:"v"`
	NodeID string `json:"node_id"`
	Sig    string `json:"sig"`
}

type resultMsg struct {
	V     int    `json:"v"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// signedPayload builds the byte string the node signs.
func signedPayload(nodeID string, challenge []byte) []byte {
	p := make([]byte, 0, len(signatureContext)+1+len(nodeID)+1+len(challenge))
	p = append(p, signatureContext...)
	p = append(p, 0)
	p = append(p, nodeID...)
	p = append(p, 0)
	p = append(p, challenge...)
	return p
}

// VerifyFunc resolves a node id to its registered public key.
// Returning false rejects the node.
type VerifyFunc func(nodeID string) (ed25519.PublicKey, bool)

// ServerHandshake runs the broker side on conn. On success it returns the
// authenticated node id; on failure the caller should close conn.
func ServerHandshake(conn net.Conn, lookup VerifyFunc) (string, error) {
	deadline := time.Now().Add(handshakeWindow)
	_ = conn.SetDeadline(deadline)
	defer conn.SetDeadline(time.Time{})

	challenge := make([]byte, challengeSize)
	if _, err := rand.Read(challenge); err != nil {
		return "", fmt.Errorf("tunnelauth: generate challenge: %w", err)
	}
	if err := writeMsg(conn, challengeMsg{V: Version, Challenge: base64.StdEncoding.EncodeToString(challenge)}); err != nil {
		return "", err
	}

	var resp responseMsg
	if err := readMsg(conn, &resp); err != nil {
		return "", err
	}
	if resp.V != Version {
		return "", reject(conn, "unsupported handshake version")
	}
	if resp.NodeID == "" {
		return "", reject(conn, "missing node_id")
	}
	sig, err := base64.StdEncoding.DecodeString(resp.Sig)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return "", reject(conn, "malformed signature")
	}
	pub, ok := lookup(resp.NodeID)
	if !ok {
		return "", reject(conn, "unknown node")
	}
	if !ed25519.Verify(pub, signedPayload(resp.NodeID, challenge), sig) {
		return "", reject(conn, "bad signature")
	}
	if err := writeMsg(conn, resultMsg{V: Version, OK: true}); err != nil {
		return "", err
	}
	return resp.NodeID, nil
}

func reject(conn net.Conn, reason string) error {
	_ = writeMsg(conn, resultMsg{V: Version, OK: false, Error: reason})
	return fmt.Errorf("tunnelauth: rejected peer: %s", reason)
}

// ClientHandshake runs the node side on conn: receive challenge, sign, await
// verdict. On success the connection is ready for the mux.
func ClientHandshake(conn net.Conn, nodeID string, key ed25519.PrivateKey) error {
	deadline := time.Now().Add(handshakeWindow)
	_ = conn.SetDeadline(deadline)
	defer conn.SetDeadline(time.Time{})

	var ch challengeMsg
	if err := readMsg(conn, &ch); err != nil {
		return err
	}
	if ch.V != Version {
		return errors.New("tunnelauth: unsupported handshake version from broker")
	}
	challenge, err := base64.StdEncoding.DecodeString(ch.Challenge)
	if err != nil || len(challenge) != challengeSize {
		return errors.New("tunnelauth: malformed challenge")
	}
	sig := ed25519.Sign(key, signedPayload(nodeID, challenge))
	if err := writeMsg(conn, responseMsg{V: Version, NodeID: nodeID, Sig: base64.StdEncoding.EncodeToString(sig)}); err != nil {
		return err
	}
	var res resultMsg
	if err := readMsg(conn, &res); err != nil {
		return err
	}
	if !res.OK {
		return fmt.Errorf("tunnelauth: broker rejected registration: %s", res.Error)
	}
	return nil
}

func writeMsg(w io.Writer, v any) error {
	body, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("tunnelauth: marshal: %w", err)
	}
	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(len(body)))
	if _, err := w.Write(lenBuf[:]); err != nil {
		return fmt.Errorf("tunnelauth: write: %w", err)
	}
	if _, err := w.Write(body); err != nil {
		return fmt.Errorf("tunnelauth: write: %w", err)
	}
	return nil
}

func readMsg(r io.Reader, v any) error {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return fmt.Errorf("tunnelauth: read length: %w", err)
	}
	n := binary.BigEndian.Uint32(lenBuf[:])
	if n == 0 || n > maxAuthMsgBytes {
		return fmt.Errorf("tunnelauth: implausible message length %d", n)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return fmt.Errorf("tunnelauth: read body: %w", err)
	}
	if err := json.Unmarshal(body, v); err != nil {
		return fmt.Errorf("tunnelauth: unmarshal: %w", err)
	}
	return nil
}
