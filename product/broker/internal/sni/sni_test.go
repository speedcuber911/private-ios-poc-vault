package sni

import (
	"bytes"
	"crypto/tls"
	"net"
	"testing"
)

// captureClientHello runs a real crypto/tls client handshake attempt against
// one end of a pipe and returns the raw bytes it sent.
func captureClientHello(t *testing.T, serverName string) []byte {
	t.Helper()
	clientEnd, serverEnd := net.Pipe()
	defer clientEnd.Close()
	defer serverEnd.Close()

	go func() {
		c := tls.Client(clientEnd, &tls.Config{
			ServerName:         serverName,
			InsecureSkipVerify: true,
		})
		_ = c.Handshake() // will fail once we close the pipe; we only want the hello
	}()

	buf := make([]byte, 64<<10)
	var raw bytes.Buffer
	// One Read is enough for the record header + start; keep reading until
	// PeekClientHello has what it needs by feeding through it directly below.
	n, err := serverEnd.Read(buf)
	if err != nil {
		t.Fatalf("read client hello: %v", err)
	}
	raw.Write(buf[:n])
	return raw.Bytes()
}

func TestPeekClientHelloExtractsSNI(t *testing.T) {
	wire := captureClientHello(t, "node1.tun.test")
	host, peeked, err := PeekClientHello(bytes.NewReader(wire))
	if err != nil {
		t.Fatalf("PeekClientHello: %v", err)
	}
	if host != "node1.tun.test" {
		t.Fatalf("host = %q, want node1.tun.test", host)
	}
	if !bytes.Equal(peeked, wire[:len(peeked)]) {
		t.Fatal("peeked bytes are not a prefix of the wire bytes — replay would corrupt the handshake")
	}
	if len(peeked) < 5 {
		t.Fatalf("peeked only %d bytes", len(peeked))
	}
}

func TestPeekClientHelloNoSNI(t *testing.T) {
	// crypto/tls omits the server_name extension for empty ServerName +
	// InsecureSkipVerify.
	wire := captureClientHello(t, "")
	_, _, err := PeekClientHello(bytes.NewReader(wire))
	if err == nil {
		t.Fatal("expected error for hello without SNI")
	}
}

func TestPeekClientHelloRejectsGarbage(t *testing.T) {
	cases := [][]byte{
		[]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), // plaintext HTTP
		{0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28}, // TLS alert record
		{},
		{0x16, 0x03},
	}
	for i, c := range cases {
		if _, _, err := PeekClientHello(bytes.NewReader(c)); err == nil {
			t.Fatalf("case %d: expected error, got none", i)
		}
	}
}
