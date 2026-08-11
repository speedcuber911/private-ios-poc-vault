// Package certs generates throwaway test PKI entirely in-process with
// crypto/x509 — no openssl, nothing touches disk unless the caller writes it.
//
// Two independent chains, mirroring the product trust model (04-product-plan
// §4.3):
//
//   - node CA -> node TLS server cert (SAN `<node-id>.tun.test`); the client
//     pins the node CA, so no public PKI is involved on the data path;
//   - device CA -> device client cert; the node requires and verifies client
//     certs against the device CA.
//
// Plus an ed25519 node identity keypair used only for tunnel registration
// with the broker (never for TLS).
package certs

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"time"
)

// Fixture is a complete in-memory PKI for one node + one device.
type Fixture struct {
	// Node identity (tunnel registration, ed25519 — not TLS).
	NodeID      string
	NodePub     ed25519.PublicKey
	NodePriv    ed25519.PrivateKey
	NodePubPEM  []byte
	NodePrivPEM []byte

	// Node CA (the CA the phone pins).
	NodeCACert *x509.Certificate
	NodeCAPEM  []byte

	// Node TLS server cert, issued by the node CA.
	NodeTLSCert tls.Certificate

	// Device CA (the CA the node verifies client certs against).
	DeviceCACert *x509.Certificate
	DeviceCAPEM  []byte

	// Device client cert, issued by the device CA.
	DeviceTLSCert tls.Certificate
	DeviceCertPEM []byte
	DeviceKeyPEM  []byte
}

// Generate builds the full fixture for nodeID served at dnsName
// (e.g. "node1", "node1.tun.test").
func Generate(nodeID, dnsName string) (*Fixture, error) {
	f := &Fixture{NodeID: nodeID}

	var err error
	f.NodePub, f.NodePriv, err = ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("certs: node identity key: %w", err)
	}
	if f.NodePubPEM, err = marshalPKIXPEM(f.NodePub); err != nil {
		return nil, err
	}
	if f.NodePrivPEM, err = marshalPKCS8PEM(f.NodePriv); err != nil {
		return nil, err
	}

	nodeCACert, nodeCAKey, nodeCAPEM, err := newCA("relay spike node CA " + nodeID)
	if err != nil {
		return nil, err
	}
	f.NodeCACert, f.NodeCAPEM = nodeCACert, nodeCAPEM

	f.NodeTLSCert, _, _, err = issueLeaf(nodeCACert, nodeCAKey, leafSpec{
		commonName: dnsName,
		dnsNames:   []string{dnsName},
		serverAuth: true,
	})
	if err != nil {
		return nil, fmt.Errorf("certs: node server cert: %w", err)
	}

	devCACert, devCAKey, devCAPEM, err := newCA("relay spike device CA")
	if err != nil {
		return nil, err
	}
	f.DeviceCACert, f.DeviceCAPEM = devCACert, devCAPEM

	f.DeviceTLSCert, f.DeviceCertPEM, f.DeviceKeyPEM, err = issueLeaf(devCACert, devCAKey, leafSpec{
		commonName: "device-1",
		clientAuth: true,
	})
	if err != nil {
		return nil, fmt.Errorf("certs: device client cert: %w", err)
	}
	return f, nil
}

type leafSpec struct {
	commonName string
	dnsNames   []string
	serverAuth bool
	clientAuth bool
}

func newCA(commonName string) (*x509.Certificate, *ecdsa.PrivateKey, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("certs: CA key: %w", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          mustSerial(),
		Subject:               pkix.Name{CommonName: commonName},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("certs: create CA: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("certs: parse CA: %w", err)
	}
	return cert, key, pemEncode("CERTIFICATE", der), nil
}

func issueLeaf(ca *x509.Certificate, caKey *ecdsa.PrivateKey, spec leafSpec) (tls.Certificate, []byte, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, nil, fmt.Errorf("leaf key: %w", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: mustSerial(),
		Subject:      pkix.Name{CommonName: spec.commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		DNSNames:     spec.dnsNames,
	}
	if spec.serverAuth {
		tmpl.ExtKeyUsage = append(tmpl.ExtKeyUsage, x509.ExtKeyUsageServerAuth)
	}
	if spec.clientAuth {
		tmpl.ExtKeyUsage = append(tmpl.ExtKeyUsage, x509.ExtKeyUsageClientAuth)
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, nil, nil, fmt.Errorf("create leaf: %w", err)
	}
	certPEM := pemEncode("CERTIFICATE", der)
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return tls.Certificate{}, nil, nil, fmt.Errorf("marshal leaf key: %w", err)
	}
	keyPEM := pemEncode("PRIVATE KEY", keyDER)
	tlsCert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, nil, nil, fmt.Errorf("assemble keypair: %w", err)
	}
	return tlsCert, certPEM, keyPEM, nil
}

// NodeTLSServerConfig is the TLS context the fake relayd terminates with:
// its node-CA-issued server cert, client certs REQUIRED and verified against
// the device CA.
func (f *Fixture) NodeTLSServerConfig() *tls.Config {
	pool := x509.NewCertPool()
	pool.AddCert(f.DeviceCACert)
	return &tls.Config{
		Certificates: []tls.Certificate{f.NodeTLSCert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
		MinVersion:   tls.VersionTLS12,
	}
}

// DeviceTLSClientConfig is the phone-side TLS context: pins the node CA
// (no system roots) and presents the device client cert.
func (f *Fixture) DeviceTLSClientConfig(serverName string) *tls.Config {
	pool := x509.NewCertPool()
	pool.AddCert(f.NodeCACert)
	return &tls.Config{
		RootCAs:      pool,
		ServerName:   serverName,
		Certificates: []tls.Certificate{f.DeviceTLSCert},
		MinVersion:   tls.VersionTLS12,
	}
}

// ParseEd25519PublicKeyPEM loads a PKIX-encoded ed25519 public key.
func ParseEd25519PublicKeyPEM(pemBytes []byte) (ed25519.PublicKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("certs: no PEM block in public key input")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("certs: parse public key: %w", err)
	}
	edPub, ok := pub.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("certs: not an ed25519 public key (%T)", pub)
	}
	return edPub, nil
}

// ParseEd25519PrivateKeyPEM loads a PKCS8-encoded ed25519 private key.
func ParseEd25519PrivateKeyPEM(pemBytes []byte) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("certs: no PEM block in private key input")
	}
	priv, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("certs: parse private key: %w", err)
	}
	edPriv, ok := priv.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("certs: not an ed25519 private key (%T)", priv)
	}
	return edPriv, nil
}

func marshalPKIXPEM(pub ed25519.PublicKey) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, fmt.Errorf("certs: marshal public key: %w", err)
	}
	return pemEncode("PUBLIC KEY", der), nil
}

func marshalPKCS8PEM(priv ed25519.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, fmt.Errorf("certs: marshal private key: %w", err)
	}
	return pemEncode("PRIVATE KEY", der), nil
}

func pemEncode(blockType string, der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der})
}

func mustSerial() *big.Int {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		panic(err) // rand.Reader failure is unrecoverable in a test fixture
	}
	return serial
}
