// Command fake-relayd runs the spike node daemon: it dials OUT to the broker
// tunnel, authenticates with its ed25519 node key, and serves HTTPS over the
// tunnel — terminating TLS itself and requiring device client certificates.
//
// Example (after `go run ./cmd/genfixtures`):
//
//	go run ./cmd/fake-relayd -broker 127.0.0.1:8444 -node-id node1 \
//	    -identity-key testdata/node1-identity.pem \
//	    -tls-cert testdata/node1-tls-cert.pem -tls-key testdata/node1-tls-key.pem \
//	    -device-ca testdata/device-ca.pem
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"flag"
	"log"
	"os"

	"relay.example/broker/internal/certs"
	"relay.example/broker/internal/relayd"
)

func main() {
	brokerAddr := flag.String("broker", "127.0.0.1:8444", "broker tunnel address")
	nodeID := flag.String("node-id", "node1", "node id (must be registered with the broker)")
	identityKey := flag.String("identity-key", "", "path to ed25519 node identity private key PEM")
	tlsCert := flag.String("tls-cert", "", "path to node TLS server certificate PEM (node-CA-issued)")
	tlsKey := flag.String("tls-key", "", "path to node TLS server key PEM")
	deviceCA := flag.String("device-ca", "", "path to device CA certificate PEM (client certs verified against this)")
	flag.Parse()

	for name, v := range map[string]*string{"identity-key": identityKey, "tls-cert": tlsCert, "tls-key": tlsKey, "device-ca": deviceCA} {
		if *v == "" {
			log.Fatalf("-%s is required", name)
		}
	}

	keyPEM, err := os.ReadFile(*identityKey)
	if err != nil {
		log.Fatalf("read identity key: %v", err)
	}
	priv, err := certs.ParseEd25519PrivateKeyPEM(keyPEM)
	if err != nil {
		log.Fatalf("parse identity key: %v", err)
	}
	serverCert, err := tls.LoadX509KeyPair(*tlsCert, *tlsKey)
	if err != nil {
		log.Fatalf("load TLS keypair: %v", err)
	}
	caPEM, err := os.ReadFile(*deviceCA)
	if err != nil {
		log.Fatalf("read device CA: %v", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		log.Fatalf("no certificates found in %s", *deviceCA)
	}

	r := &relayd.Relayd{
		NodeID: *nodeID,
		Key:    priv,
		TLS: &tls.Config{
			Certificates: []tls.Certificate{serverCert},
			ClientAuth:   tls.RequireAndVerifyClientCert,
			ClientCAs:    pool,
			MinVersion:   tls.VersionTLS12,
		},
		Logf: log.Printf,
	}
	if err := r.Run(context.Background(), *brokerAddr); err != nil {
		log.Fatal(err)
	}
}
