// Package mux implements a minimal length-prefixed stream multiplexer over a
// single reliable byte stream (TCP for the spike; wss in production).
//
// Frame format (all integers big-endian):
//
//	+------+-------------+-----------+----------------+
//	| type | stream id   | length    | payload        |
//	| 1 B  | 4 B         | 4 B       | `length` bytes |
//	+------+-------------+-----------+----------------+
//
// Frame types:
//
//	SYN  (1) — open stream `id` (payload empty)
//	DATA (2) — payload bytes for stream `id`
//	FIN  (3) — sender will write no more data on stream `id` (half-close)
//	RST  (4) — abort stream `id`
//	PING (5) — keepalive probe (id 0)
//	PONG (6) — keepalive reply (id 0)
//
// The session initiator opens streams with odd ids, the responder (if it ever
// opens streams) with even ids. There is no flow control in the spike; see
// README "production deltas".
package mux

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

const (
	frameSYN  = 1
	frameDATA = 2
	frameFIN  = 3
	frameRST  = 4
	framePING = 5
	framePONG = 6

	headerSize     = 9
	maxFramePayload = 1 << 20 // read-side sanity cap
	writeChunk      = 32 << 10
)

var (
	// ErrSessionClosed is returned once the underlying connection is gone.
	ErrSessionClosed = errors.New("mux: session closed")
	errStreamReset   = errors.New("mux: stream reset by peer")
)

// Session multiplexes logical streams over conn.
type Session struct {
	conn      net.Conn
	initiator bool

	wmu sync.Mutex // serializes whole frames onto conn

	mu       sync.Mutex
	streams  map[uint32]*Stream
	nextID   uint32
	closed   bool
	closeErr error

	acceptCh chan *Stream
	done     chan struct{}
}

// NewSession wraps conn. The initiator side opens streams with odd ids.
// The caller must not touch conn afterwards.
func NewSession(conn net.Conn, initiator bool) *Session {
	s := &Session{
		conn:      conn,
		initiator: initiator,
		streams:   make(map[uint32]*Stream),
		acceptCh:  make(chan *Stream, 64),
		done:      make(chan struct{}),
	}
	if initiator {
		s.nextID = 1
	} else {
		s.nextID = 2
	}
	go s.readLoop()
	return s
}

// OpenStream opens a new logical stream.
func (s *Session) OpenStream() (*Stream, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, ErrSessionClosed
	}
	id := s.nextID
	s.nextID += 2
	st := newStream(s, id)
	s.streams[id] = st
	s.mu.Unlock()

	if err := s.writeFrame(frameSYN, id, nil); err != nil {
		s.removeStream(id)
		return nil, err
	}
	return st, nil
}

// AcceptStream blocks until the peer opens a stream or the session dies.
func (s *Session) AcceptStream() (*Stream, error) {
	select {
	case st := <-s.acceptCh:
		return st, nil
	case <-s.done:
		return nil, s.closeError()
	}
}

// Ping sends a keepalive probe. Errors indicate a dead session.
func (s *Session) Ping() error { return s.writeFrame(framePING, 0, nil) }

// Close tears down the session and all streams.
func (s *Session) Close() error { return s.closeWith(ErrSessionClosed) }

// Done is closed when the session terminates.
func (s *Session) Done() <-chan struct{} { return s.done }

func (s *Session) closeError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closeErr != nil {
		return s.closeErr
	}
	return ErrSessionClosed
}

func (s *Session) closeWith(err error) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.closeErr = err
	streams := make([]*Stream, 0, len(s.streams))
	for _, st := range s.streams {
		streams = append(streams, st)
	}
	s.streams = map[uint32]*Stream{}
	s.mu.Unlock()

	close(s.done)
	for _, st := range streams {
		st.sessionClosed(err)
	}
	return s.conn.Close()
}

func (s *Session) removeStream(id uint32) {
	s.mu.Lock()
	delete(s.streams, id)
	s.mu.Unlock()
}

func (s *Session) getStream(id uint32) *Stream {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.streams[id]
}

func (s *Session) writeFrame(ftype byte, id uint32, payload []byte) error {
	var hdr [headerSize]byte
	hdr[0] = ftype
	binary.BigEndian.PutUint32(hdr[1:5], id)
	binary.BigEndian.PutUint32(hdr[5:9], uint32(len(payload)))

	s.wmu.Lock()
	defer s.wmu.Unlock()
	if _, err := s.conn.Write(hdr[:]); err != nil {
		return fmt.Errorf("mux: write header: %w", err)
	}
	if len(payload) > 0 {
		if _, err := s.conn.Write(payload); err != nil {
			return fmt.Errorf("mux: write payload: %w", err)
		}
	}
	return nil
}

func (s *Session) readLoop() {
	var hdr [headerSize]byte
	for {
		if _, err := io.ReadFull(s.conn, hdr[:]); err != nil {
			s.closeWith(fmt.Errorf("mux: read: %w", err))
			return
		}
		ftype := hdr[0]
		id := binary.BigEndian.Uint32(hdr[1:5])
		length := binary.BigEndian.Uint32(hdr[5:9])
		if length > maxFramePayload {
			s.closeWith(fmt.Errorf("mux: oversized frame (%d bytes)", length))
			return
		}
		var payload []byte
		if length > 0 {
			payload = make([]byte, length)
			if _, err := io.ReadFull(s.conn, payload); err != nil {
				s.closeWith(fmt.Errorf("mux: read payload: %w", err))
				return
			}
		}

		switch ftype {
		case frameSYN:
			st := newStream(s, id)
			s.mu.Lock()
			if s.closed {
				s.mu.Unlock()
				return
			}
			s.streams[id] = st
			s.mu.Unlock()
			select {
			case s.acceptCh <- st:
			default:
				// Accept backlog full: refuse the stream.
				s.removeStream(id)
				_ = s.writeFrame(frameRST, id, nil)
			}
		case frameDATA:
			if st := s.getStream(id); st != nil {
				st.deliver(payload)
			}
		case frameFIN:
			if st := s.getStream(id); st != nil {
				st.peerFIN()
			}
		case frameRST:
			if st := s.getStream(id); st != nil {
				st.peerRST()
				s.removeStream(id)
			}
		case framePING:
			_ = s.writeFrame(framePONG, 0, nil)
		case framePONG:
			// Nothing to do in the spike; production tracks liveness here.
		default:
			s.closeWith(fmt.Errorf("mux: unknown frame type %d", ftype))
			return
		}
	}
}

// Stream is one logical bidirectional byte stream. It implements net.Conn.
type Stream struct {
	id   uint32
	sess *Session

	mu           sync.Mutex
	cond         *sync.Cond
	buf          bytes.Buffer
	readClosed   bool // peer sent FIN
	reset        bool // peer sent RST or session died
	resetErr     error
	localClosed  bool // we called Close
	writeClosed  bool // we sent FIN
	readDeadline time.Time
	dlTimer      *time.Timer
}

func newStream(s *Session, id uint32) *Stream {
	st := &Stream{id: id, sess: s}
	st.cond = sync.NewCond(&st.mu)
	return st
}

// ID returns the stream's mux id.
func (st *Stream) ID() uint32 { return st.id }

func (st *Stream) deliver(p []byte) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.localClosed || st.reset {
		return
	}
	st.buf.Write(p)
	st.cond.Broadcast()
}

func (st *Stream) peerFIN() {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.readClosed = true
	st.cond.Broadcast()
}

func (st *Stream) peerRST() {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.reset = true
	st.resetErr = errStreamReset
	st.cond.Broadcast()
}

func (st *Stream) sessionClosed(err error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.reset = true
	st.resetErr = err
	st.cond.Broadcast()
}

// Read implements net.Conn.
func (st *Stream) Read(p []byte) (int, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for {
		if st.localClosed {
			return 0, net.ErrClosed
		}
		if st.buf.Len() > 0 {
			return st.buf.Read(p)
		}
		if st.reset {
			return 0, st.resetErr
		}
		if st.readClosed {
			return 0, io.EOF
		}
		if !st.readDeadline.IsZero() && !time.Now().Before(st.readDeadline) {
			return 0, timeoutError{}
		}
		st.cond.Wait()
	}
}

// Write implements net.Conn.
func (st *Stream) Write(p []byte) (int, error) {
	st.mu.Lock()
	if st.localClosed || st.writeClosed {
		st.mu.Unlock()
		return 0, net.ErrClosed
	}
	if st.reset {
		err := st.resetErr
		st.mu.Unlock()
		return 0, err
	}
	st.mu.Unlock()

	total := 0
	for len(p) > 0 {
		n := len(p)
		if n > writeChunk {
			n = writeChunk
		}
		if err := st.sess.writeFrame(frameDATA, st.id, p[:n]); err != nil {
			return total, err
		}
		total += n
		p = p[n:]
	}
	return total, nil
}

// CloseWrite half-closes the stream: the peer sees EOF after draining.
func (st *Stream) CloseWrite() error {
	st.mu.Lock()
	if st.writeClosed || st.localClosed {
		st.mu.Unlock()
		return nil
	}
	st.writeClosed = true
	st.mu.Unlock()
	return st.sess.writeFrame(frameFIN, st.id, nil)
}

// Close implements net.Conn. It half-closes toward the peer and releases
// local readers.
func (st *Stream) Close() error {
	st.mu.Lock()
	if st.localClosed {
		st.mu.Unlock()
		return nil
	}
	st.localClosed = true
	alreadyFIN := st.writeClosed
	st.writeClosed = true
	st.cond.Broadcast()
	st.mu.Unlock()

	st.sess.removeStream(st.id)
	if !alreadyFIN {
		return st.sess.writeFrame(frameFIN, st.id, nil)
	}
	return nil
}

// SetReadDeadline implements net.Conn.
func (st *Stream) SetReadDeadline(t time.Time) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.readDeadline = t
	if st.dlTimer != nil {
		st.dlTimer.Stop()
		st.dlTimer = nil
	}
	if !t.IsZero() {
		d := time.Until(t)
		if d <= 0 {
			st.cond.Broadcast()
		} else {
			st.dlTimer = time.AfterFunc(d, func() {
				st.mu.Lock()
				st.cond.Broadcast()
				st.mu.Unlock()
			})
		}
	}
	return nil
}

// SetWriteDeadline implements net.Conn. Writes go straight to the session
// socket; per-stream write deadlines are accepted but not enforced in the
// spike.
func (st *Stream) SetWriteDeadline(time.Time) error { return nil }

// SetDeadline implements net.Conn.
func (st *Stream) SetDeadline(t time.Time) error {
	_ = st.SetWriteDeadline(t)
	return st.SetReadDeadline(t)
}

// LocalAddr implements net.Conn.
func (st *Stream) LocalAddr() net.Addr { return muxAddr{st.id} }

// RemoteAddr implements net.Conn.
func (st *Stream) RemoteAddr() net.Addr { return muxAddr{st.id} }

type muxAddr struct{ id uint32 }

func (a muxAddr) Network() string { return "mux" }
func (a muxAddr) String() string  { return fmt.Sprintf("mux-stream-%d", a.id) }

type timeoutError struct{}

func (timeoutError) Error() string   { return "mux: read deadline exceeded" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }
