// Package broker implements the spike tunnel broker:
//
//   - a tunnel listener where nodes dial out, prove possession of their
//     registered ed25519 node key, and then hold a multiplexed session;
//   - a passthrough listener that peeks the TLS ClientHello of inbound
//     client connections WITHOUT terminating TLS, routes on the SNI
//     `<node-id>.<suffix>`, and splices raw bytes into a fresh mux stream
//     on that node's tunnel session.
//
// The broker never holds TLS keys for the data path: it moves ciphertext.
package broker

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"relay.example/broker/internal/mux"
	"relay.example/broker/internal/sni"
	"relay.example/broker/internal/tunnelauth"
)

const helloTimeout = 5 * time.Second

// Broker routes passthrough connections into node tunnel sessions.
type Broker struct {
	// Suffix is the SNI suffix routed by this broker, e.g. ".tun.test".
	suffix string
	logf   func(format string, args ...any)

	mu       sync.Mutex
	registry map[string]ed25519.PublicKey
	tunnels  map[string]*mux.Session
	fallback func(string) (ed25519.PublicKey, bool)
}

// New creates a broker routing SNI names of the form `<node-id><suffix>`.
func New(suffix string, logf func(string, ...any)) *Broker {
	if logf == nil {
		logf = log.Printf
	}
	return &Broker{
		suffix:   suffix,
		logf:     logf,
		registry: make(map[string]ed25519.PublicKey),
		tunnels:  make(map[string]*mux.Session),
	}
}

// RegisterNode adds (or replaces) a node's public key in the in-memory
// registry. Production: rows in the control-plane DB.
func (b *Broker) RegisterNode(nodeID string, pub ed25519.PublicKey) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.registry[nodeID] = pub
}

// SetFallbackLookup installs a dynamic resolver consulted when a node id is
// not in the static registry (production: the control-plane registry hook).
func (b *Broker) SetFallbackLookup(fn func(string) (ed25519.PublicKey, bool)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.fallback = fn
}

func (b *Broker) lookupKey(nodeID string) (ed25519.PublicKey, bool) {
	b.mu.Lock()
	pub, ok := b.registry[nodeID]
	fallback := b.fallback
	b.mu.Unlock()
	if ok {
		return pub, true
	}
	if fallback != nil {
		return fallback(nodeID) // network call — must run outside the lock
	}
	return nil, false
}

func (b *Broker) session(nodeID string) *mux.Session {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.tunnels[nodeID]
}

// ServeTunnel accepts node tunnel connections on l until l is closed.
func (b *Broker) ServeTunnel(l net.Listener) error {
	for {
		conn, err := l.Accept()
		if err != nil {
			return err
		}
		go b.handleTunnelConn(conn)
	}
}

func (b *Broker) handleTunnelConn(conn net.Conn) {
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	nodeID, err := tunnelauth.ServerHandshake(conn, b.lookupKey)
	if err != nil {
		b.logf("broker: tunnel auth failed from %s: %v", conn.RemoteAddr(), err)
		_ = conn.Close()
		return
	}

	sess := mux.NewSession(conn, true /* broker initiates streams */)

	b.mu.Lock()
	if old := b.tunnels[nodeID]; old != nil {
		_ = old.Close()
	}
	b.tunnels[nodeID] = sess
	b.mu.Unlock()
	b.logf("broker: node %q tunnel registered from %s", nodeID, conn.RemoteAddr())

	<-sess.Done()

	b.mu.Lock()
	if b.tunnels[nodeID] == sess {
		delete(b.tunnels, nodeID)
	}
	b.mu.Unlock()
	b.logf("broker: node %q tunnel gone", nodeID)
}

// ServePassthrough accepts client data-path connections on l until l closes.
func (b *Broker) ServePassthrough(l net.Listener) error {
	for {
		conn, err := l.Accept()
		if err != nil {
			return err
		}
		go b.handlePassthroughConn(conn)
	}
}

func (b *Broker) handlePassthroughConn(conn net.Conn) {
	defer conn.Close()
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}

	_ = conn.SetReadDeadline(time.Now().Add(helloTimeout))
	host, peeked, err := sni.PeekClientHello(conn)
	if err != nil {
		b.logf("broker: passthrough %s: bad hello: %v", conn.RemoteAddr(), err)
		return
	}
	_ = conn.SetReadDeadline(time.Time{})

	nodeID, ok := strings.CutSuffix(strings.ToLower(host), b.suffix)
	if !ok || nodeID == "" || strings.Contains(nodeID, ".") {
		b.logf("broker: passthrough %s: unroutable SNI %q", conn.RemoteAddr(), host)
		return
	}
	sess := b.session(nodeID)
	if sess == nil {
		b.logf("broker: passthrough %s: node %q not connected", conn.RemoteAddr(), nodeID)
		return
	}
	stream, err := sess.OpenStream()
	if err != nil {
		b.logf("broker: passthrough %s: open stream to %q: %v", conn.RemoteAddr(), nodeID, err)
		return
	}
	defer stream.Close()

	// Replay the peeked ClientHello bytes, then splice.
	if _, err := stream.Write(peeked); err != nil {
		b.logf("broker: passthrough %s: replay hello to %q: %v", conn.RemoteAddr(), nodeID, err)
		return
	}
	splice(conn, stream)
}

// splice copies bidirectionally between the client socket and the mux stream,
// propagating half-closes so TLS close_notify and HTTP connection teardown
// behave normally.
func splice(client net.Conn, stream *mux.Stream) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(stream, client) // client -> node
		_ = stream.CloseWrite()
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(client, stream) // node -> client
		if tc, ok := client.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		} else {
			_ = client.Close()
		}
	}()
	wg.Wait()
}

// Serve runs both listeners and blocks until either fails.
func (b *Broker) Serve(passthrough, tunnel net.Listener) error {
	errCh := make(chan error, 2)
	go func() { errCh <- fmt.Errorf("passthrough listener: %w", b.ServePassthrough(passthrough)) }()
	go func() { errCh <- fmt.Errorf("tunnel listener: %w", b.ServeTunnel(tunnel)) }()
	err := <-errCh
	_ = passthrough.Close()
	_ = tunnel.Close()
	if errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}
