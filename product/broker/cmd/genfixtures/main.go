// Command genfixtures writes a throwaway PKI for manual binary runs into
// ./testdata (gitignored). Pure crypto/x509 — no openssl. The Go tests do
// NOT need this: they generate the same fixture in-memory.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"relay.example/broker/internal/certs"
)

func main() {
	dir := flag.String("out", "testdata", "output directory")
	nodeID := flag.String("node-id", "node1", "node id")
	suffix := flag.String("suffix", ".tun.test", "SNI suffix")
	flag.Parse()

	f, err := certs.Generate(*nodeID, *nodeID+*suffix)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(*dir, 0o700); err != nil {
		log.Fatal(err)
	}

	// Re-derive leaf PEMs for the node TLS pair from the tls.Certificate.
	nodeTLSCertPEM := pemChain(f.NodeTLSCert.Certificate)
	nodeTLSKeyPEM, err := pemPKCS8(f.NodeTLSCert.PrivateKey)
	if err != nil {
		log.Fatal(err)
	}

	files := map[string][]byte{
		*nodeID + "-identity-pub.pem": f.NodePubPEM,
		*nodeID + "-identity.pem":     f.NodePrivPEM,
		*nodeID + "-tls-cert.pem":     nodeTLSCertPEM,
		*nodeID + "-tls-key.pem":      nodeTLSKeyPEM,
		"node-ca.pem":                 f.NodeCAPEM,
		"device-ca.pem":               f.DeviceCAPEM,
		"device-cert.pem":             f.DeviceCertPEM,
		"device-key.pem":              f.DeviceKeyPEM,
	}
	for name, data := range files {
		path := filepath.Join(*dir, name)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			log.Fatal(err)
		}
		fmt.Println("wrote", path)
	}
}
