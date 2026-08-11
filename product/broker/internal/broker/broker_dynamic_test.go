package broker

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
)

func TestLookupFallsBackToDynamicRegistry(t *testing.T) {
	pubStatic, _, _ := ed25519.GenerateKey(rand.Reader)
	pubDyn, _, _ := ed25519.GenerateKey(rand.Reader)

	b := New(".tun.test", func(string, ...any) {})
	b.RegisterNode("static-node", pubStatic)
	b.SetFallbackLookup(func(id string) (ed25519.PublicKey, bool) {
		if id == "node-0011223344556677" {
			return pubDyn, true
		}
		return nil, false
	})

	if got, ok := b.lookupKey("static-node"); !ok || !got.Equal(pubStatic) {
		t.Fatal("static lookup broken")
	}
	if got, ok := b.lookupKey("node-0011223344556677"); !ok || !got.Equal(pubDyn) {
		t.Fatal("dynamic fallback not used")
	}
	if _, ok := b.lookupKey("node-unknown"); ok {
		t.Fatal("unknown id resolved")
	}
}
