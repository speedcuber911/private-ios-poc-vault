// Package registry resolves node ids to ed25519 public keys from the
// control-plane hook GET /v1/tunnel/nodes/:id, with a small TTL cache so a
// reconnect storm cannot hammer the cloud. Unknown ids are negative-cached
// briefly. A resolver with no URL is inert (static registrations only).
package registry

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"relay.example/broker/internal/certs"
)

type Config struct {
	URL         string
	Token       string
	HTTPClient  *http.Client
	PositiveTTL time.Duration
	NegativeTTL time.Duration
	Now         func() time.Time
	Logf        func(string, ...any)
}

type entry struct {
	key     ed25519.PublicKey // nil ⇒ negative entry
	expires time.Time
}

type Resolver struct {
	cfg    Config
	client *http.Client
	now    func() time.Time
	logf   func(string, ...any)

	mu    sync.Mutex
	cache map[string]entry
}

func NewResolver(cfg Config) *Resolver {
	if cfg.PositiveTTL == 0 {
		cfg.PositiveTTL = 60 * time.Second
	}
	if cfg.NegativeTTL == 0 {
		cfg.NegativeTTL = 10 * time.Second
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second}
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Resolver{cfg: cfg, client: client, now: now, logf: logf, cache: make(map[string]entry)}
}

// Lookup satisfies tunnelauth.VerifyFunc.
func (r *Resolver) Lookup(nodeID string) (ed25519.PublicKey, bool) {
	if r.cfg.URL == "" {
		return nil, false
	}
	r.mu.Lock()
	if e, ok := r.cache[nodeID]; ok && r.now().Before(e.expires) {
		r.mu.Unlock()
		return e.key, e.key != nil
	}
	r.mu.Unlock()

	key, found := r.fetch(nodeID)
	ttl := r.cfg.NegativeTTL
	if found {
		ttl = r.cfg.PositiveTTL
	}
	r.mu.Lock()
	r.cache[nodeID] = entry{key: key, expires: r.now().Add(ttl)}
	r.mu.Unlock()
	return key, found
}

func (r *Resolver) fetch(nodeID string) (ed25519.PublicKey, bool) {
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/tunnel/nodes/%s", r.cfg.URL, nodeID), nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("Authorization", "Bearer "+r.cfg.Token)
	resp, err := r.client.Do(req)
	if err != nil {
		r.logf("registry: fetch %s: %v", nodeID, err)
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, false
	}
	var payload struct {
		Pubkey string `json:"pubkey"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Pubkey == "" {
		return nil, false
	}
	return parsePubkey(payload.Pubkey)
}

func parsePubkey(s string) (ed25519.PublicKey, bool) {
	if key, err := certs.ParseEd25519PublicKeyPEM([]byte(s)); err == nil {
		return key, true
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, false
	}
	return ed25519.PublicKey(raw), true
}
