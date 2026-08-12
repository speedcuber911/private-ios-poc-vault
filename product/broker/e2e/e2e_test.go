// Package e2e proves the M0 exit gate on localhost: phone-side TLS client
// -> broker SNI passthrough -> mux tunnel -> fake relayd terminating mTLS,
// with UNBUFFERED SSE through the whole pipe.
package e2e

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
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

type env struct {
	fixture         *certs.Fixture
	passthroughAddr string
}

// safeLogger forwards to t.Logf until the test ends, then discards: broker
// and relayd goroutines wind down asynchronously during cleanup, and logging
// into a finished test races with the framework's teardown.
type safeLogger struct {
	mu   sync.Mutex
	done bool
	t    *testing.T
}

func newSafeLogger(t *testing.T) *safeLogger {
	l := &safeLogger{t: t}
	// Registered FIRST so it runs LAST (cleanups are LIFO): everything after
	// this point is silenced.
	t.Cleanup(func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.done = true
	})
	return l
}

func (l *safeLogger) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.done {
		l.t.Logf(format, args...)
	}
}

func startEnv(t *testing.T) *env {
	t.Helper()
	logf := newSafeLogger(t).logf

	f, err := certs.Generate(nodeID, nodeHost)
	if err != nil {
		t.Fatalf("generate fixture: %v", err)
	}

	b := broker.New(suffix, logf)
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

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	r := &relayd.Relayd{
		NodeID: nodeID,
		Key:    f.NodePriv,
		TLS:    f.NodeTLSServerConfig(),
		Logf:   logf,
	}
	go r.Run(ctx, tl.Addr().String())

	e := &env{fixture: f, passthroughAddr: pl.Addr().String()}
	e.waitReady(t)
	return e
}

// waitReady polls healthz until the relayd tunnel is registered.
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
			t.Fatalf("relayd never became reachable through the broker: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// httpClient builds the phone-side client: dials the broker passthrough,
// sends serverName as SNI, pins the node CA, optionally presents the device
// client cert.
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
			if tc, ok := raw.(*net.TCPConn); ok {
				_ = tc.SetNoDelay(true)
			}
			tconn := tls.Client(raw, cfg)
			if err := tconn.HandshakeContext(ctx); err != nil {
				raw.Close()
				return nil, err
			}
			return tconn, nil
		},
		DisableKeepAlives: false,
	}
	return &http.Client{Transport: transport, Timeout: 15 * time.Second}
}

func TestHealthzThroughTunnel(t *testing.T) {
	e := startEnv(t)
	client := e.httpClient(nodeHost, true)
	defer client.CloseIdleConnections()

	// First request: includes TCP + TLS handshake through the tunnel.
	coldStart := time.Now()
	resp, err := client.Get("https://" + nodeHost + "/healthz")
	if err != nil {
		t.Fatalf("healthz: %v", err)
	}
	cold := time.Since(coldStart)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200", resp.StatusCode)
	}
	if strings.TrimSpace(string(body)) != "ok" {
		t.Fatalf("healthz body = %q, want ok", body)
	}
	if len(resp.TLS.PeerCertificates) == 0 {
		t.Fatal("no peer certificate — TLS did not terminate on the node")
	}
	if got := resp.TLS.PeerCertificates[0].Subject.CommonName; got != nodeHost {
		t.Fatalf("peer cert CN = %q, want %q (node cert, not broker)", got, nodeHost)
	}

	// Warm keep-alive requests: pure tunnel round-trip latency.
	const n = 30
	lat := make([]time.Duration, 0, n)
	for i := 0; i < n; i++ {
		start := time.Now()
		resp, err := client.Get("https://" + nodeHost + "/healthz")
		if err != nil {
			t.Fatalf("healthz #%d: %v", i, err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		lat = append(lat, time.Since(start))
	}
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
	t.Logf("healthz latency through tunnel: cold(start incl. mTLS handshake)=%v warm min=%v p50=%v p95=%v max=%v",
		cold, lat[0], lat[n/2], lat[n*95/100], lat[n-1])
}

// sseEvent is one received SSE event with its arrival timestamp.
type sseEvent struct {
	at   time.Time
	text string
}

// readSSE consumes body and timestamps each complete event ("\n\n" boundary)
// at the Read call that completed it — bufio is deliberately avoided so
// timing reflects wire arrival.
func readSSE(body io.Reader) ([]sseEvent, error) {
	var events []sseEvent
	var acc bytes.Buffer
	buf := make([]byte, 4096)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			now := time.Now()
			acc.Write(buf[:n])
			for {
				idx := bytes.Index(acc.Bytes(), []byte("\n\n"))
				if idx < 0 {
					break
				}
				events = append(events, sseEvent{at: now, text: string(acc.Next(idx + 2))})
			}
		}
		if err == io.EOF {
			return events, nil
		}
		if err != nil {
			return events, err
		}
	}
}

func TestSSEArrivesIncrementally(t *testing.T) {
	e := startEnv(t)
	client := e.httpClient(nodeHost, true)
	defer client.CloseIdleConnections()

	start := time.Now()
	resp, err := client.Get("https://" + nodeHost + "/v1/test/stream")
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stream status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type = %q, want text/event-stream", ct)
	}

	events, err := readSSE(resp.Body)
	if err != nil {
		t.Fatalf("read SSE: %v", err)
	}
	if len(events) != 15 {
		t.Fatalf("got %d events, want 15", len(events))
	}
	firstLatency := events[0].at.Sub(start)
	if firstLatency > 1500*time.Millisecond {
		t.Fatalf("first event took %v — looks buffered", firstLatency)
	}

	// The buffering check: if anything in the path (broker splice, mux, TLS,
	// chunked encoding) buffered the stream, events would arrive in one or two
	// bursts. Emitted every 200ms, so demand most inter-event gaps stay near
	// the emission interval.
	var gaps []time.Duration
	for i := 1; i < len(events); i++ {
		gaps = append(gaps, events[i].at.Sub(events[i-1].at))
	}
	spaced := 0
	for _, g := range gaps {
		if g >= 120*time.Millisecond {
			spaced++
		}
	}
	span := events[len(events)-1].at.Sub(events[0].at)
	sorted := append([]time.Duration(nil), gaps...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	t.Logf("SSE through tunnel: first event %v after request; span %v; gaps min=%v p50=%v max=%v; %d/%d gaps >= 120ms",
		firstLatency, span, sorted[0], sorted[len(sorted)/2], sorted[len(sorted)-1], spaced, len(gaps))

	if spaced < 10 {
		t.Fatalf("only %d/%d gaps >= 120ms — events arrived in bursts, stream is being buffered", spaced, len(gaps))
	}
	if span < 2200*time.Millisecond {
		t.Fatalf("all events within %v — stream was buffered and dumped", span)
	}
}

func TestWrongSNIFails(t *testing.T) {
	e := startEnv(t)
	client := e.httpClient("ghost"+suffix, true)
	defer client.CloseIdleConnections()

	resp, err := client.Get("https://ghost" + suffix + "/healthz")
	if err == nil {
		resp.Body.Close()
		t.Fatalf("request with unknown SNI succeeded (status %d), want failure", resp.StatusCode)
	}
	t.Logf("unknown SNI correctly failed: %v", err)
}

func TestMissingClientCertRejected(t *testing.T) {
	e := startEnv(t)
	client := e.httpClient(nodeHost, false /* no device cert */)
	defer client.CloseIdleConnections()

	resp, err := client.Get("https://" + nodeHost + "/healthz")
	if err == nil {
		resp.Body.Close()
		t.Fatalf("request WITHOUT client cert succeeded (status %d) — node TLS is not enforcing mTLS", resp.StatusCode)
	}
	t.Logf("missing client cert correctly rejected: %v", err)
}

func TestConcurrentStreamsOverOneTunnel(t *testing.T) {
	e := startEnv(t)

	type result struct {
		firstEvent time.Time
		done       time.Time
		count      int
		err        error
	}
	runStream := func() result {
		client := e.httpClient(nodeHost, true)
		defer client.CloseIdleConnections()
		resp, err := client.Get("https://" + nodeHost + "/v1/test/stream")
		if err != nil {
			return result{err: err}
		}
		defer resp.Body.Close()
		events, err := readSSE(resp.Body)
		if err != nil {
			return result{err: err}
		}
		if len(events) == 0 {
			return result{err: fmt.Errorf("no events")}
		}
		return result{firstEvent: events[0].at, done: time.Now(), count: len(events)}
	}

	var wg sync.WaitGroup
	results := make([]result, 2)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = runStream()
		}()
	}

	// While both SSE streams are live, a third logical stream must still work.
	time.Sleep(1 * time.Second)
	hc := e.httpClient(nodeHost, true)
	resp, err := hc.Get("https://" + nodeHost + "/healthz")
	if err != nil {
		t.Fatalf("healthz during concurrent SSE: %v", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz during concurrent SSE: status %d", resp.StatusCode)
	}
	hc.CloseIdleConnections()

	wg.Wait()
	for i, r := range results {
		if r.err != nil {
			t.Fatalf("stream %d failed: %v", i, r.err)
		}
		if r.count != 15 {
			t.Fatalf("stream %d got %d events, want 15", i, r.count)
		}
	}
	// Mux proof: both streams were live at the same time over ONE tunnel TCP
	// connection — each finished after the other had already delivered data.
	if !results[0].done.After(results[1].firstEvent) || !results[1].done.After(results[0].firstEvent) {
		t.Fatalf("streams did not overlap: %+v", results)
	}
	t.Logf("two SSE streams + healthz ran concurrently over one tunnel session")
}
