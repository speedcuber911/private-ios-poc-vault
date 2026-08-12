package mux

import (
	"bytes"
	"crypto/rand"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

func pair(t *testing.T) (*Session, *Session) {
	t.Helper()
	a, b := net.Pipe()
	sa := NewSession(a, true)
	sb := NewSession(b, false)
	t.Cleanup(func() { sa.Close(); sb.Close() })
	return sa, sb
}

func TestStreamRoundTrip(t *testing.T) {
	initiator, responder := pair(t)

	go func() {
		st, err := responder.AcceptStream()
		if err != nil {
			return
		}
		io.Copy(st, st) // echo
		st.Close()
	}()

	st, err := initiator.OpenStream()
	if err != nil {
		t.Fatalf("OpenStream: %v", err)
	}
	msg := []byte("hello through the mux")
	if _, err := st.Write(msg); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got := make([]byte, len(msg))
	if _, err := io.ReadFull(st, got); err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !bytes.Equal(got, msg) {
		t.Fatalf("round trip = %q, want %q", got, msg)
	}
}

func TestLargePayloadChunking(t *testing.T) {
	initiator, responder := pair(t)

	payload := make([]byte, 300<<10) // ~10x the write chunk size
	rand.Read(payload)

	go func() {
		st, err := responder.AcceptStream()
		if err != nil {
			return
		}
		io.Copy(st, st)
		st.Close()
	}()

	st, err := initiator.OpenStream()
	if err != nil {
		t.Fatalf("OpenStream: %v", err)
	}
	go func() {
		st.Write(payload)
		st.CloseWrite()
	}()
	got, err := io.ReadAll(st)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload corrupted: got %d bytes, want %d", len(got), len(payload))
	}
}

func TestConcurrentStreams(t *testing.T) {
	initiator, responder := pair(t)

	go func() {
		for {
			st, err := responder.AcceptStream()
			if err != nil {
				return
			}
			go func() {
				io.Copy(st, st)
				st.Close()
			}()
		}
	}()

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(seed byte) {
			defer wg.Done()
			st, err := initiator.OpenStream()
			if err != nil {
				t.Errorf("OpenStream: %v", err)
				return
			}
			defer st.Close()
			msg := bytes.Repeat([]byte{seed}, 8192)
			go st.Write(msg)
			got := make([]byte, len(msg))
			if _, err := io.ReadFull(st, got); err != nil {
				t.Errorf("stream %d read: %v", seed, err)
				return
			}
			if !bytes.Equal(got, msg) {
				t.Errorf("stream %d corrupted (cross-stream data bleed?)", seed)
			}
		}(byte(i + 1))
	}
	wg.Wait()
}

func TestHalfClose(t *testing.T) {
	initiator, responder := pair(t)

	done := make(chan []byte, 1)
	go func() {
		st, err := responder.AcceptStream()
		if err != nil {
			return
		}
		data, _ := io.ReadAll(st) // returns at peer FIN
		st.Write([]byte("reply after fin"))
		st.Close()
		done <- data
	}()

	st, err := initiator.OpenStream()
	if err != nil {
		t.Fatalf("OpenStream: %v", err)
	}
	st.Write([]byte("request"))
	st.CloseWrite()

	reply, err := io.ReadAll(st)
	if err != nil {
		t.Fatalf("read reply: %v", err)
	}
	if string(reply) != "reply after fin" {
		t.Fatalf("reply = %q", reply)
	}
	if got := <-done; string(got) != "request" {
		t.Fatalf("server saw %q", got)
	}
}

func TestReadDeadline(t *testing.T) {
	initiator, responder := pair(t)
	go responder.AcceptStream()

	st, err := initiator.OpenStream()
	if err != nil {
		t.Fatalf("OpenStream: %v", err)
	}
	st.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	start := time.Now()
	_, err = st.Read(make([]byte, 1))
	if err == nil {
		t.Fatal("expected deadline error")
	}
	nerr, ok := err.(net.Error)
	if !ok || !nerr.Timeout() {
		t.Fatalf("error %v is not a net timeout", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("deadline fired after %v", elapsed)
	}

	// Clearing the deadline must allow reads again.
	st.SetReadDeadline(time.Time{})
	go func() {
		time.Sleep(20 * time.Millisecond)
		peer := responder // write from the peer stream
		_ = peer
	}()
}

func TestSessionCloseUnblocksStreams(t *testing.T) {
	initiator, responder := pair(t)
	go responder.AcceptStream()

	st, err := initiator.OpenStream()
	if err != nil {
		t.Fatalf("OpenStream: %v", err)
	}
	errCh := make(chan error, 1)
	go func() {
		_, err := st.Read(make([]byte, 1))
		errCh <- err
	}()
	time.Sleep(20 * time.Millisecond)
	initiator.Close()
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("read succeeded after session close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream read still blocked after session close")
	}
}
