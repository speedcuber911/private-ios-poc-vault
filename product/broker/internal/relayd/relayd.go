// Package relayd is the spike stand-in for the real node daemon. It dials
// OUT to the broker's tunnel listener (no inbound ports on the node),
// authenticates with its ed25519 node key, then serves HTTPS over the
// multiplexed tunnel streams — terminating TLS ITSELF with a node-CA-issued
// cert and REQUIRING device client certificates. The broker only ever sees
// ciphertext.
package relayd

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"fmt"
	"log"
	"net"
	"net/http"
	"time"

	"relay.example/broker/internal/mux"
	"relay.example/broker/internal/tunnelauth"
)

const (
	heartbeatInterval = 15 * time.Second

	// SSE timing served by /v1/test/stream.
	sseInterval = 200 * time.Millisecond
	sseDuration = 3 * time.Second
)

// Relayd is one fake node instance.
type Relayd struct {
	NodeID  string
	Key     ed25519.PrivateKey
	TLS     *tls.Config // server context: node cert + RequireAndVerifyClientCert
	Logf    func(string, ...any)
	Handler http.Handler // defaults to Handler()
}

// Run connects to the broker tunnel at addr and serves until ctx is done or
// the tunnel session dies. (The spike does one connection, no reconnect —
// see README "production deltas".)
func (r *Relayd) Run(ctx context.Context, addr string) error {
	logf := r.Logf
	if logf == nil {
		logf = log.Printf
	}
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		return fmt.Errorf("relayd: dial broker: %w", err)
	}
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	if err := tunnelauth.ClientHandshake(conn, r.NodeID, r.Key); err != nil {
		_ = conn.Close()
		return err
	}
	logf("relayd: node %q registered with broker %s", r.NodeID, addr)

	sess := mux.NewSession(conn, false /* broker initiates streams */)
	defer sess.Close()

	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := sess.Ping(); err != nil {
					return
				}
			case <-sess.Done():
				return
			}
		}
	}()

	handler := r.Handler
	if handler == nil {
		handler = Handler()
	}
	httpSrv := &http.Server{Handler: handler}
	tlsLn := tls.NewListener(&sessionListener{sess: sess}, r.TLS)

	done := make(chan error, 1)
	go func() { done <- httpSrv.Serve(tlsLn) }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
		return ctx.Err()
	case err := <-done:
		return fmt.Errorf("relayd: http server: %w", err)
	}
}

// sessionListener adapts mux stream acceptance to net.Listener so
// tls.NewListener + http.Server can sit on top unchanged.
type sessionListener struct{ sess *mux.Session }

func (l *sessionListener) Accept() (net.Conn, error) { return l.sess.AcceptStream() }
func (l *sessionListener) Close() error              { return l.sess.Close() }
func (l *sessionListener) Addr() net.Addr            { return tunnelAddr{} }

type tunnelAddr struct{}

func (tunnelAddr) Network() string { return "relay-tunnel" }
func (tunnelAddr) String() string  { return "relay-tunnel" }

// Handler serves the two spike endpoints.
func Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})
	m.HandleFunc("GET /v1/test/stream", func(w http.ResponseWriter, req *http.Request) {
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		fl.Flush()

		total := int(sseDuration / sseInterval)
		ticker := time.NewTicker(sseInterval)
		defer ticker.Stop()
		for i := 1; i <= total; i++ {
			select {
			case <-req.Context().Done():
				return
			case t := <-ticker.C:
				fmt.Fprintf(w, "id: %d\ndata: {\"seq\":%d,\"ts\":%d}\n\n", i, i, t.UnixMilli())
				fl.Flush() // one flush per event: the whole point of the spike
			}
		}
	})
	return m
}
