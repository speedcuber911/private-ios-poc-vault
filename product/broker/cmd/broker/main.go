// Command broker runs the spike tunnel broker: an SNI passthrough listener
// for the data path and a tunnel listener for outbound node connections.
//
// Node registration (in-memory for the spike) comes from repeated
// -node id=path/to/node-pub.pem flags.
//
// Example (after `go run ./cmd/genfixtures`):
//
//	go run ./cmd/broker -passthrough 127.0.0.1:8443 -tunnel 127.0.0.1:8444 \
//	    -suffix .tun.test -node node1=testdata/node1-identity-pub.pem
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"strings"

	"relay.example/broker/internal/broker"
	"relay.example/broker/internal/certs"
)

type nodeFlags []string

func (n *nodeFlags) String() string     { return strings.Join(*n, ",") }
func (n *nodeFlags) Set(v string) error { *n = append(*n, v); return nil }

func main() {
	passthroughAddr := flag.String("passthrough", "127.0.0.1:8443", "data-path listener (TLS passthrough, SNI-routed)")
	tunnelAddr := flag.String("tunnel", "127.0.0.1:8444", "node tunnel listener")
	suffix := flag.String("suffix", ".tun.test", "SNI suffix routed by this broker")
	var nodes nodeFlags
	flag.Var(&nodes, "node", "node registration as <node-id>=<path to ed25519 public key PEM> (repeatable)")
	flag.Parse()

	b := broker.New(*suffix, log.Printf)
	for _, spec := range nodes {
		id, path, ok := strings.Cut(spec, "=")
		if !ok {
			fmt.Fprintf(os.Stderr, "bad -node value %q (want id=pubkey.pem)\n", spec)
			os.Exit(2)
		}
		pemBytes, err := os.ReadFile(path)
		if err != nil {
			log.Fatalf("read node pubkey: %v", err)
		}
		pub, err := certs.ParseEd25519PublicKeyPEM(pemBytes)
		if err != nil {
			log.Fatalf("parse node pubkey %s: %v", path, err)
		}
		b.RegisterNode(id, pub)
		log.Printf("registered node %q", id)
	}

	pl, err := net.Listen("tcp", *passthroughAddr)
	if err != nil {
		log.Fatalf("listen passthrough: %v", err)
	}
	tl, err := net.Listen("tcp", *tunnelAddr)
	if err != nil {
		log.Fatalf("listen tunnel: %v", err)
	}
	log.Printf("broker up: passthrough=%s tunnel=%s suffix=%s", pl.Addr(), tl.Addr(), *suffix)
	if err := b.Serve(pl, tl); err != nil {
		log.Fatal(err)
	}
}
