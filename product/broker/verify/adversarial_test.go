// Package verify is an INDEPENDENT adversarial verification suite for the W1
// broker spike, written by a second agent to distrust-check the spike's own
// e2e tests. It deliberately re-implements the tunnel-registration handshake
// from the README wire spec alone (length-prefixed JSON, domain-separated
// ed25519 signature) so that interop here also proves the README matches the
// implementation.
//
// Covered attacks / failure modes:
//   - replaying a previously valid tunnel-auth response against a fresh
//     challenge (must be rejected, must not clobber the live session);
//   - unknown SNI (must fail during the TLS handshake, before any HTTP);
//   - no client cert (must be refused by the NODE's TLS stack as a TLS
//     alert, never an HTTP 403);
//   - tunnel TCP connection dying mid-SSE-stream (client must error out
//     promptly, and subsequent passthrough connects must fail).
package verify

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"relay.example/broker/internal/broker"
	"relay.example/broker/internal/certs"
	"relay.example/broker/internal/relayd"
)

const (
	nodeID   = "node1"
	suffix   = ".tun.test"
	nodeHost = nodeID + suffix
)

// --- wire-spec reimplementation (from README only, NOT internal/tunnelauth) ---

func readLPJSON(c net.Conn, v any) error {
	var lb [4]byte
	if _, err := io.ReadFull(c, lb[:]); err != nil {
		return err
	}
	n := binary.BigEndian.Uint32(lb[:])
	if n == 0 || n > 4096 {
		return fmt.Errorf("implausible frame length %d", n)
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(c, b); err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func frameJSON(v any) []byte {
	body, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	out := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(out[:4], uint32(len(body)))
	copy(out[4:], body)
	return out
}

func signAuth(nodeID string, challenge []byte, key ed25519.PrivateKey) []byte {
	// README: sig covers "relay-tunnel-auth-v1" || 0x00 || node_id || 0x00 || challenge
	p := append([]byte("relay-tunnel-auth-v1"), 0)
	p = append(p, nodeID...)
	p = append(p, 0)
	p = append(p, challenge...)
	return ed25519.Sign(key, p)
}

type challengeMsg struct {
	V         int    `json:"v"`
	Challenge string `json:"challenge"`
}
type resultMsg struct {
	V     int    `json:"v"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// specHandshake performs the node side of the registration handshake purely
// from the README spec and returns the exact framed response bytes it sent
// (for replay attacks).
func specHandshake(t *testing.T, conn net.Conn, id string, key ed25519.PrivateKey) (responseFrame []byte) {
	t.Helper()
	var ch challengeMsg
	if err := readLPJSON(conn, &ch); err != nil {
		t.Fatalf("read challenge: %v", err)
	}
	if ch.V != 1 {
		t.Fatalf("challenge v = %d, want 1 (README)", ch.V)
	}
	challenge, err := base64.StdEncoding.DecodeString(ch.Challenge)
	if err != nil || len(challenge) != 32 {
		t.Fatalf("challenge not base64 32B as README claims: %v (len %d)", err, len(challenge))
	}
	sig := signAuth(id, challenge, key)
	responseFrame = frameJSON(map[string]any{
		"v": 1, "node_id": id, "sig": base64.StdEncoding.EncodeToString(sig),
	})
	if _, err := conn.Write(responseFrame); err != nil {
		t.Fatalf("write response: %v", err)
	}
	var res resultMsg
	if err := readLPJSON(conn, &res); err != nil {
		t.Fatalf("read result: %v", err)
	}
	if !res.OK {
		t.Fatalf("spec-derived handshake rejected: %q — README wire spec does not match implementation", res.Error)
	}
	return responseFrame
}

// --- environment ---

type env struct {
	fixture         *certs.Fixture
	passthroughAddr string
	tunnelAddr      string
	relaydErr       chan error
}

// startEnv boots broker (+ optionally relayd, dialing via dialAddr which may
// be a kill-proxy in front of the tunnel listener).
func startEnv(t *testing.T, withRelayd bool, dialAddr func(tunnelAddr string) string) *env {
	t.Helper()
	f, err := certs.Generate(nodeID, nodeHost)
	if err != nil {
		t.Fatalf("generate fixture: %v", err)
	}
	b := broker.New(suffix, func(string, ...any) {})
	b.RegisterNode(nodeID, f.NodePub)

	pl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen passthrough: %v", err)
	}
	tl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tunnel: %v", err)
	}
	go b.Serve(pl, tl)
	t.Cleanup(func() { pl.Close(); tl.Close() })

	e := &env{
		fixture:         f,
		passthroughAddr: pl.Addr().String(),
		tunnelAddr:      tl.Addr().String(),
		relaydErr:       make(chan error, 1),
	}
	if withRelayd {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		r := &relayd.Relayd{
			NodeID: nodeID,
			Key:    f.NodePriv,
			TLS:    f.NodeTLSServerConfig(),
			Logf:   func(string, ...any) {},
		}
		addr := e.tunnelAddr
		if dialAddr != nil {
			addr = dialAddr(e.tunnelAddr)
		}
		go func() { e.relaydErr <- r.Run(ctx, addr) }()
		e.waitReady(t)
	}
	return e
}

func (e *env) waitReady(t *testing.T) {
	t.Helper()
	client := e.httpClient(nodeHost, true)
	defer client.CloseIdleConnections()
	deadline := time.Now().Add(5 * time.Second)
	for {
		resp, err := client.Get("https://" + nodeHost + "/healthz")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("relayd never reachable through broker: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (e *env) httpClient(serverName string, withClientCert bool) *http.Client {
	cfg := e.fixture.DeviceTLSClientConfig(serverName)
	if !withClientCert {
		cfg.Certificates = nil
	}
	transport := &http.Transport{
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			raw, err := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", e.passthroughAddr)
			if err != nil {
				return nil, err
			}
			tconn := tls.Client(raw, cfg)
			if err := tconn.HandshakeContext(ctx); err != nil {
				raw.Close()
				return nil, err
			}
			return tconn, nil
		},
	}
	return &http.Client{Transport: transport, Timeout: 15 * time.Second}
}

// --- kill-proxy: a TCP relay whose connections we can sever mid-stream ---

type killProxy struct {
	ln    net.Listener
	mu    sync.Mutex
	conns []net.Conn
}

func startKillProxy(t *testing.T, target string) *killProxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("kill-proxy listen: %v", err)
	}
	p := &killProxy{ln: ln}
	t.Cleanup(func() { ln.Close(); p.KillAll() })
	go func() {
		for {
			down, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", target)
			if err != nil {
				down.Close()
				continue
			}
			p.mu.Lock()
			p.conns = append(p.conns, down, up)
			p.mu.Unlock()
			go func() { io.Copy(up, down); up.Close() }()
			go func() { io.Copy(down, up); down.Close() }()
		}
	}()
	return p
}

func (p *killProxy) Addr() string { return p.ln.Addr().String() }

func (p *killProxy) KillAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range p.conns {
		c.Close()
	}
	p.conns = nil
}

// --- the adversarial tests ---

// TestTunnelAuthReplayRejected proves a captured tunnel-auth response cannot
// be replayed: the broker issues a fresh random challenge per connection, so
// a signature over an old challenge must be rejected — and the failed replay
// must not disturb the session registered by the legitimate handshake.
func TestTunnelAuthReplayRejected(t *testing.T) {
	e := startEnv(t, false, nil)

	// Legitimate registration, implemented purely from the README wire spec.
	conn1, err := net.Dial("tcp", e.tunnelAddr)
	if err != nil {
		t.Fatalf("dial tunnel: %v", err)
	}
	defer conn1.Close()
	captured := specHandshake(t, conn1, nodeID, e.fixture.NodePriv)
	t.Logf("legit handshake from README spec accepted; captured %d-byte response frame", len(captured))

	// Attacker: new connection, ignore the fresh challenge, replay the
	// captured response verbatim.
	conn2, err := net.Dial("tcp", e.tunnelAddr)
	if err != nil {
		t.Fatalf("dial tunnel (attacker): %v", err)
	}
	defer conn2.Close()
	var ch challengeMsg
	if err := readLPJSON(conn2, &ch); err != nil {
		t.Fatalf("attacker read challenge: %v", err)
	}
	if ch.Challenge == "" {
		t.Fatal("no challenge issued on second connection")
	}
	if _, err := conn2.Write(captured); err != nil {
		t.Fatalf("attacker replay write: %v", err)
	}
	var res resultMsg
	if err := readLPJSON(conn2, &res); err != nil {
		t.Fatalf("attacker read verdict: %v", err)
	}
	if res.OK {
		t.Fatal("SECURITY: replayed tunnel-auth response was ACCEPTED")
	}
	t.Logf("replay rejected: %q", res.Error)

	// The broker must close the attacker connection (no mux session).
	conn2.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 64)
	if n, err := conn2.Read(buf); err == nil {
		t.Fatalf("attacker connection still alive after rejection (read %d bytes)", n)
	}

	// The legitimate session (conn1) must still be the registered tunnel:
	// a passthrough connection must reach it (broker opens a mux stream and
	// replays the ClientHello — we accept the raw SYN+DATA on conn1's side by
	// observing bytes arriving, which proves the route survived the replay).
	pconn, err := net.Dial("tcp", e.passthroughAddr)
	if err != nil {
		t.Fatalf("dial passthrough: %v", err)
	}
	defer pconn.Close()
	tc := tls.Client(pconn, e.fixture.DeviceTLSClientConfig(nodeHost))
	go tc.Handshake() // will not complete (conn1 isn't a real relayd); routing is what we check
	conn1.SetReadDeadline(time.Now().Add(3 * time.Second))
	hdr := make([]byte, 9)
	if _, err := io.ReadFull(conn1, hdr); err != nil {
		t.Fatalf("legit session no longer routed after failed replay: %v", err)
	}
	if hdr[0] != 1 { // SYN per README framing
		t.Fatalf("expected SYN frame (type 1) on legit session, got type %d", hdr[0])
	}
	t.Log("legit session still routed after failed replay (SYN observed)")
}

// TestUnknownSNIFailsDuringHandshake proves an unregistered SNI dies at the
// TLS layer: the handshake itself errors (connection closed by broker), no
// ServerHello, no HTTP.
func TestUnknownSNIFailsDuringHandshake(t *testing.T) {
	e := startEnv(t, true, nil)

	raw, err := net.Dial("tcp", e.passthroughAddr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer raw.Close()
	tc := tls.Client(raw, e.fixture.DeviceTLSClientConfig("ghost"+suffix))
	err = tc.HandshakeContext(context.Background())
	if err == nil {
		t.Fatalf("TLS handshake with unknown SNI SUCCEEDED; peer cert chain: %v", tc.ConnectionState().PeerCertificates)
	}
	t.Logf("unknown SNI failed during handshake as required: %v", err)
}

// TestNoClientCertFailsAtTLSLayerNotHTTP proves that omitting the device
// client cert is refused by the node's TLS stack (alert), and that not a
// single byte of HTTP ever comes back — i.e. mTLS enforcement, not a 403.
func TestNoClientCertFailsAtTLSLayerNotHTTP(t *testing.T) {
	e := startEnv(t, true, nil)

	raw, err := net.Dial("tcp", e.passthroughAddr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer raw.Close()
	cfg := e.fixture.DeviceTLSClientConfig(nodeHost)
	cfg.Certificates = nil // no device cert
	tc := tls.Client(raw, cfg)

	hsErr := tc.HandshakeContext(context.Background())
	if hsErr == nil {
		// TLS 1.3: client may finish before the server evaluates the (empty)
		// client Certificate. Try to use the connection: the alert must
		// surface on write/read, and no application data may arrive.
		fmt.Fprintf(tc, "GET /healthz HTTP/1.1\r\nHost: %s\r\n\r\n", nodeHost)
		tc.SetReadDeadline(time.Now().Add(3 * time.Second))
		buf := make([]byte, 2048)
		n, rerr := tc.Read(buf)
		if rerr == nil || n > 0 {
			t.Fatalf("SECURITY: got %d bytes back without a client cert: %q (err=%v)", n, buf[:n], rerr)
		}
		if !strings.Contains(rerr.Error(), "tls:") {
			t.Fatalf("failure was not a TLS-layer alert: %v", rerr)
		}
		t.Logf("no-client-cert refused by node TLS stack post-handshake: %v", rerr)
	} else {
		if !strings.Contains(hsErr.Error(), "tls:") {
			t.Fatalf("handshake failure not TLS-layer: %v", hsErr)
		}
		t.Logf("no-client-cert refused during handshake: %v", hsErr)
	}
}

// TestTunnelDropMidStream severs the tunnel TCP connection while an SSE
// stream is live: the client must error out promptly (not hang, not receive
// a phantom-complete stream), and new passthrough connects must then fail.
func TestTunnelDropMidStream(t *testing.T) {
	var proxy *killProxy
	e := startEnv(t, true, func(tunnelAddr string) string {
		proxy = startKillProxy(t, tunnelAddr)
		return proxy.Addr()
	})

	client := e.httpClient(nodeHost, true)
	defer client.CloseIdleConnections()
	resp, err := client.Get("https://" + nodeHost + "/v1/test/stream")
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	defer resp.Body.Close()

	type outcome struct {
		events int
		err    error
		took   time.Duration
	}
	killed := make(chan time.Time, 1)
	done := make(chan outcome, 1)
	go func() {
		var events int
		buf := make([]byte, 4096)
		var acc []byte
		for {
			n, err := resp.Body.Read(buf)
			acc = append(acc, buf[:n]...)
			for {
				i := strings.Index(string(acc), "\n\n")
				if i < 0 {
					break
				}
				events++
				acc = acc[i+2:]
			}
			if events >= 3 && len(killed) == 0 {
				// Sever the tunnel after a few live events.
				proxy.KillAll()
				killed <- time.Now()
			}
			if err != nil {
				var at time.Time
				select {
				case at = <-killed:
				default:
					at = time.Now()
				}
				done <- outcome{events: events, err: err, took: time.Since(at)}
				return
			}
		}
	}()

	select {
	case o := <-done:
		if o.err == io.EOF && o.events >= 15 {
			t.Fatalf("stream completed cleanly (%d events) despite tunnel kill — kill did not land", o.events)
		}
		if o.events >= 15 {
			t.Fatalf("received all %d events after tunnel death", o.events)
		}
		if o.took > 3*time.Second {
			t.Fatalf("client took %v after tunnel death to observe failure — too slow", o.took)
		}
		t.Logf("tunnel death surfaced to client in %v after %d events: %v", o.took, o.events, o.err)
	case <-time.After(10 * time.Second):
		t.Fatal("client HUNG after tunnel death — stream read never returned")
	}

	// Broker must have dropped the route: fresh connects must fail the TLS
	// handshake (node not connected), not hang and not succeed.
	deadline := time.Now().Add(3 * time.Second)
	for {
		raw, err := net.DialTimeout("tcp", e.passthroughAddr, 2*time.Second)
		if err != nil {
			t.Fatalf("dial passthrough: %v", err)
		}
		tc := tls.Client(raw, e.fixture.DeviceTLSClientConfig(nodeHost))
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		hsErr := tc.HandshakeContext(ctx)
		cancel()
		raw.Close()
		if hsErr != nil {
			t.Logf("post-drop passthrough correctly fails handshake: %v", hsErr)
			return
		}
		// The broker may not have reaped the session yet (readLoop notices
		// asynchronously); allow a short grace window.
		if time.Now().After(deadline) {
			t.Fatal("passthrough handshake still SUCCEEDS after tunnel death — stale route")
		}
		time.Sleep(100 * time.Millisecond)
	}
}
