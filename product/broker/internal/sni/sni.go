// Package sni extracts the server_name extension from a TLS ClientHello
// without terminating TLS. Every byte read from the wire is preserved so the
// broker can replay it verbatim into the node tunnel.
package sni

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	recordTypeHandshake  = 0x16
	handshakeClientHello = 0x01
	extServerName        = 0x0000
	sniHostNameType      = 0

	maxHelloBytes = 64 << 10 // sanity cap on total peeked bytes
)

// ErrNoSNI is returned when a well-formed ClientHello carries no server_name.
var ErrNoSNI = errors.New("sni: client hello has no server_name extension")

// PeekClientHello reads TLS records from r until a complete ClientHello
// handshake message is buffered, then parses out the SNI host name.
// It returns the host name and every byte consumed from r (record framing
// included), which the caller must forward before splicing the connection.
func PeekClientHello(r io.Reader) (host string, peeked []byte, err error) {
	var raw bytes.Buffer          // exact wire bytes consumed
	var handshake bytes.Buffer    // concatenated handshake payloads
	tee := io.TeeReader(r, &raw)

	// Read records until the full ClientHello message is available.
	// (A ClientHello may span multiple records, e.g. with large PQ key shares.)
	need := -1 // total handshake message size incl. 4-byte msg header; unknown yet
	for {
		var hdr [5]byte
		if _, err := io.ReadFull(tee, hdr[:]); err != nil {
			return "", raw.Bytes(), fmt.Errorf("sni: read record header: %w", err)
		}
		if hdr[0] != recordTypeHandshake {
			return "", raw.Bytes(), fmt.Errorf("sni: not a TLS handshake record (type 0x%02x)", hdr[0])
		}
		if hdr[1] != 0x03 {
			return "", raw.Bytes(), fmt.Errorf("sni: implausible record version 0x%02x%02x", hdr[1], hdr[2])
		}
		recLen := int(binary.BigEndian.Uint16(hdr[3:5]))
		if recLen == 0 || raw.Len()+recLen > maxHelloBytes {
			return "", raw.Bytes(), fmt.Errorf("sni: oversized or empty record (%d bytes)", recLen)
		}
		if _, err := io.CopyN(&handshake, tee, int64(recLen)); err != nil {
			return "", raw.Bytes(), fmt.Errorf("sni: read record body: %w", err)
		}
		if need < 0 && handshake.Len() >= 4 {
			hs := handshake.Bytes()
			if hs[0] != handshakeClientHello {
				return "", raw.Bytes(), fmt.Errorf("sni: not a ClientHello (handshake type 0x%02x)", hs[0])
			}
			need = 4 + int(uint32(hs[1])<<16|uint32(hs[2])<<8|uint32(hs[3]))
			if need > maxHelloBytes {
				return "", raw.Bytes(), fmt.Errorf("sni: oversized ClientHello (%d bytes)", need)
			}
		}
		if need >= 0 && handshake.Len() >= need {
			break
		}
	}

	host, err = parseClientHello(handshake.Bytes()[4:need])
	return host, raw.Bytes(), err
}

// parseClientHello walks the ClientHello body (after the 4-byte handshake
// message header) to the extensions block and pulls out server_name.
func parseClientHello(b []byte) (string, error) {
	cur := cursor{b: b}

	cur.skip(2 + 32) // legacy_version + random
	sidLen, ok := cur.u8()
	if !ok {
		return "", errors.New("sni: truncated ClientHello (session id)")
	}
	cur.skip(int(sidLen))
	csLen, ok := cur.u16()
	if !ok {
		return "", errors.New("sni: truncated ClientHello (cipher suites)")
	}
	cur.skip(int(csLen))
	compLen, ok := cur.u8()
	if !ok {
		return "", errors.New("sni: truncated ClientHello (compression)")
	}
	cur.skip(int(compLen))

	extTotal, ok := cur.u16()
	if !ok {
		return "", ErrNoSNI // extensions block absent entirely
	}
	exts, ok := cur.take(int(extTotal))
	if !ok {
		return "", errors.New("sni: truncated extensions block")
	}

	ec := cursor{b: exts}
	for {
		extType, ok := ec.u16()
		if !ok {
			return "", ErrNoSNI
		}
		extLen, ok := ec.u16()
		if !ok {
			return "", errors.New("sni: truncated extension header")
		}
		body, ok := ec.take(int(extLen))
		if !ok {
			return "", errors.New("sni: truncated extension body")
		}
		if extType != extServerName {
			continue
		}
		return parseServerNameExt(body)
	}
}

func parseServerNameExt(b []byte) (string, error) {
	c := cursor{b: b}
	listLen, ok := c.u16()
	if !ok {
		return "", errors.New("sni: truncated server_name list")
	}
	list, ok := c.take(int(listLen))
	if !ok {
		return "", errors.New("sni: truncated server_name list body")
	}
	lc := cursor{b: list}
	for {
		nameType, ok := lc.u8()
		if !ok {
			return "", ErrNoSNI
		}
		nameLen, ok := lc.u16()
		if !ok {
			return "", errors.New("sni: truncated server_name entry")
		}
		name, ok := lc.take(int(nameLen))
		if !ok {
			return "", errors.New("sni: truncated server_name value")
		}
		if nameType == sniHostNameType {
			return string(name), nil
		}
	}
}

type cursor struct {
	b   []byte
	pos int
}

func (c *cursor) skip(n int) {
	c.pos += n
	if c.pos > len(c.b) {
		c.pos = len(c.b)
	}
}

func (c *cursor) u8() (byte, bool) {
	if c.pos+1 > len(c.b) {
		return 0, false
	}
	v := c.b[c.pos]
	c.pos++
	return v, true
}

func (c *cursor) u16() (uint16, bool) {
	if c.pos+2 > len(c.b) {
		return 0, false
	}
	v := binary.BigEndian.Uint16(c.b[c.pos:])
	c.pos += 2
	return v, true
}

func (c *cursor) take(n int) ([]byte, bool) {
	if n < 0 || c.pos+n > len(c.b) {
		return nil, false
	}
	v := c.b[c.pos : c.pos+n]
	c.pos += n
	return v, true
}
