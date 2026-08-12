package registry

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func fakeCloud(t *testing.T, pub ed25519.PublicKey, hits *atomic.Int64) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/v1/tunnel/nodes/node-0011223344556677" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"unknown_node"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"nodeId":"node-0011223344556677","accountId":"a1","kind":"trial","pubkey":"` +
			base64.StdEncoding.EncodeToString(pub) + `"}`))
	}))
}

func TestLookupResolvesCachesAndNegativeCaches(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int64
	srv := fakeCloud(t, pub, &hits)
	defer srv.Close()

	now := time.Unix(1000, 0)
	r := NewResolver(Config{URL: srv.URL, Token: "tok", Now: func() time.Time { return now }})

	got, ok := r.Lookup("node-0011223344556677")
	if !ok || !got.Equal(pub) {
		t.Fatalf("want key, got ok=%v", ok)
	}
	if _, ok := r.Lookup("node-0011223344556677"); !ok {
		t.Fatal("cached lookup failed")
	}
	if hits.Load() != 1 {
		t.Fatalf("expected 1 HTTP hit (cache), got %d", hits.Load())
	}

	// Unknown node: negative cached.
	if _, ok := r.Lookup("node-ffffffffffffffff"); ok {
		t.Fatal("unknown node resolved")
	}
	if _, ok := r.Lookup("node-ffffffffffffffff"); ok {
		t.Fatal("unknown node resolved from cache")
	}
	if hits.Load() != 2 {
		t.Fatalf("expected 2 HTTP hits, got %d", hits.Load())
	}

	// Positive entry expires after TTL.
	now = now.Add(61 * time.Second)
	if _, ok := r.Lookup("node-0011223344556677"); !ok {
		t.Fatal("expired entry did not re-resolve")
	}
	if hits.Load() != 3 {
		t.Fatalf("expected re-fetch after TTL, got %d hits", hits.Load())
	}
}

func TestLookupDisabledWithoutURL(t *testing.T) {
	r := NewResolver(Config{})
	if _, ok := r.Lookup("node-0011223344556677"); ok {
		t.Fatal("resolver without URL must miss")
	}
}

func TestLookupParsesPEM(t *testing.T) {
	// The cloud may store SPKI PEM pubkeys (what relayd registers).
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"nodeId":"node-aa","accountId":"a","kind":"byo","pubkey":` + pemJSON(pub) + `}`))
	}))
	defer srv.Close()
	r := NewResolver(Config{URL: srv.URL, Token: "tok"})
	got, ok := r.Lookup("node-aa")
	if !ok || !got.Equal(pub) {
		t.Fatal("PEM pubkey did not resolve")
	}
}

func pemJSON(pub ed25519.PublicKey) string {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		panic(err)
	}
	p := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	b, _ := json.Marshal(string(p))
	return string(b)
}
