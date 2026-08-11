# W1 — Tunnel broker spike

M0 exit-gate spike for the Relay rendezvous/broker (04-product-plan §4.2
item 2, §4.3; 06-tech-execution §W1): prove **end-to-end mTLS + unbuffered
SSE through an SNI-routed reverse tunnel**, all on localhost, Go stdlib only
(no yamux, no websocket dependency, zero external modules).

```
phone-side client                 broker                        node (fake relayd)
────────────────────────────────────────────────────────────────────────────────────
tls.Client                        :passthrough        :tunnel   dials OUT, no inbound
SNI node1.tun.test  ───────────▶  peek ClientHello              ports
pins node CA                      parse SNI (no TLS   ◀──────── ed25519 challenge auth
presents device cert              termination)                  then mux session
                                  route <node-id> ──▶ stream ─▶ tls.Server (node cert,
                                  splice raw bytes              REQUIRE device cert)
                                  (ciphertext only)             /healthz, /v1/test/stream
```

The broker never holds data-path TLS keys. TLS terminates **on the node**;
the broker moves ciphertext.

## Layout

```
cmd/broker/         SNI passthrough + tunnel listener binary
cmd/fake-relayd/    outbound-dialing node daemon binary (TLS termination + mTLS)
cmd/genfixtures/    writes throwaway PKI to ./testdata for manual runs (crypto/x509, no openssl)
internal/mux/       length-prefixed stream multiplexer (net.Conn streams)
internal/sni/       ClientHello peek + SNI parse, bytes preserved for replay
internal/tunnelauth/ ed25519 challenge/response node registration
internal/broker/    routing core: registry, tunnel sessions, splice
internal/certs/     in-memory PKI fixtures (node CA, device CA, ed25519 identity)
internal/relayd/    fake node: tunnel client + HTTPS-over-mux + SSE endpoint
e2e/                end-to-end tests (the exit gate)
```

## Protocol

### 1. Tunnel registration (node → broker, plain TCP in the spike)

Length-prefixed JSON messages (`uint32` big-endian length, then body; 4 KiB
cap, 10 s handshake window):

```
broker → node   {"v":1,"challenge":"<base64 32B random>"}
node   → broker {"v":1,"node_id":"<id>","sig":"<base64 ed25519>"}
broker → node   {"v":1,"ok":true}   |   {"v":1,"ok":false,"error":"..."}
```

The signature covers `"relay-tunnel-auth-v1" || 0x00 || node_id || 0x00 ||
challenge` — domain-separated so the node identity key signs nothing else.
The broker verifies against an **in-memory registry** (`node_id → ed25519
pubkey`) for the spike. On success the same TCP connection is handed to the
mux; a second registration for the same node id replaces (closes) the first.

### 2. Mux framing (both directions after registration)

Fixed 9-byte header, big-endian, then payload:

```
+------+-----------+---------+------------------+
| type | stream id | length  | payload          |
| 1 B  | 4 B       | 4 B     | (length bytes)   |
+------+-----------+---------+------------------+

SYN=1  open stream          DATA=2  bytes for stream
FIN=3  half-close (write)   RST=4   abort stream
PING=5 keepalive            PONG=6  keepalive reply (id 0)
```

- The broker (initiator) opens streams with odd ids; the node never opens
  streams in the spike.
- Writes are chunked at 32 KiB; readers cap frames at 1 MiB.
- FIN gives TCP-like half-close semantics, so HTTP/TLS teardown works
  normally through the splice.
- **No flow control** — see production deltas.
- Streams implement `net.Conn` (including read deadlines), so
  `tls.NewListener` + `net/http` sit on top of the tunnel unchanged.

### 3. Passthrough routing

The broker reads TLS records from an inbound client connection just far
enough to assemble the full ClientHello (multi-record hellos handled, 64 KiB
cap, 5 s deadline), parses the `server_name` extension **without terminating
TLS**, maps `<node-id>.tun.test → node-id`, opens a mux stream to that
node's session, replays the peeked bytes verbatim, and splices both
directions with half-close propagation. Unroutable SNI, unknown node, or a
node not connected ⇒ the TCP connection is closed (client sees a handshake
failure; that is the spike's intended failure mode).

### 4. Node-side TLS (the actual security boundary)

fake-relayd terminates TLS itself per stream with a **node-CA-issued server
cert** (SAN `node1.tun.test`) and `ClientAuth:
RequireAndVerifyClientCert` against the **device CA**. The test client pins
the node CA (no system roots) and presents a device-CA-issued client cert —
the product trust model of 04 §4.3 in miniature. All certs are generated
in-process with `crypto/x509` (P-256, 24 h validity); the tests persist
nothing, `cmd/genfixtures` writes to gitignored `./testdata` only.

## Endpoints served through the tunnel

- `GET /healthz` → `200 ok`
- `GET /v1/test/stream` → SSE, one event every 200 ms for 3 s (15 events),
  `http.Flusher.Flush()` after every event.

## Running it

```sh
go vet ./... && go build ./... && go test ./...   # the exit gate
go test -race ./...                                # also clean

# Manual run:
go run ./cmd/genfixtures
go run ./cmd/broker -passthrough 127.0.0.1:8443 -tunnel 127.0.0.1:8444 \
    -node node1=testdata/node1-identity-pub.pem
go run ./cmd/fake-relayd -broker 127.0.0.1:8444 -node-id node1 \
    -identity-key testdata/node1-identity.pem \
    -tls-cert testdata/node1-tls-cert.pem -tls-key testdata/node1-tls-key.pem \
    -device-ca testdata/device-ca.pem
curl --cacert testdata/node-ca.pem \
     --cert testdata/device-cert.pem --key testdata/device-key.pem \
     --resolve node1.tun.test:8443:127.0.0.1 https://node1.tun.test:8443/healthz
```

## Measured results (localhost, Apple Silicon, Go 1.26.4)

From `go test -v ./e2e/` (real run, 2026-08-09):

- **healthz through the tunnel:** cold start (TCP + full mTLS handshake
  through broker + mux) **1.08 ms**; warm keep-alive requests min 94.8 µs,
  **p50 131.5 µs**, p95 167.9 µs, max 185.9 µs (n=30). Broker+mux overhead is
  effectively noise at localhost scale.
- **SSE incrementality (the buffering check):** first event 202 ms after the
  request (emitter starts at +200 ms ⇒ ~2 ms pipe latency); 15/15 events;
  inter-event gaps min 199.1 ms / **p50 200.1 ms** / max 200.5 ms; **14/14
  gaps ≥ 120 ms**; total span 2.80 s for a 2.8 s emission schedule. Nothing
  in the path (splice, mux, node TLS, chunked encoding) buffers the stream —
  events cross the tunnel the moment they are flushed.
- **Negative paths:** unknown SNI ⇒ connection closed during handshake
  (`EOF`); missing client cert ⇒ `remote error: tls: certificate required`
  **from the node's TLS stack** (also reproduced with curl/LibreSSL:
  alert 1116). Neither is broker policy — the broker cannot even see the
  request.
- **Mux proof:** two SSE streams + a healthz ran concurrently over one
  tunnel TCP connection, all incremental, all complete.

## Production deltas (spike → M2 hardening)

Deliberately out of scope here, required before beta:

1. **wss:// tunnel transport.** The node→broker leg becomes a WebSocket over
   TLS on 443 (`wss://<broker-domain>/tunnel`) so egress-restricted networks
   and corporate proxies pass it; the mux framing rides inside unchanged.
   Let's Encrypt is needed **only** for the broker's own tunnel endpoint —
   the data path stays pinned-node-CA and needs no public PKI.
2. **Registry backed by the control plane.** The in-memory `node_id →
   pubkey` map becomes the `nodes` table (04 §4.2); registration consults it
   and updates `last_seen`; SNI ids become unguessable node ids minted at
   enrollment.
3. **Reconnection/backoff + heartbeat enforcement.** The spike dials once
   and PINGs without policing PONGs. Production: exponential backoff with
   jitter on the node, server-side idle/last-pong timeouts, and route
   replacement already handles the reconnect race (newest wins).
4. **Flow control.** The spike mux has none: a slow/stalled stream consumer
   buffers unboundedly in-process. Add per-stream windows (yamux-style
   WINDOW_UPDATE) or move to HTTP/2 stream semantics before multi-tenant
   load. Idle-timeout semantics per stream belong here too.
5. **Operational hardening:** per-node and per-IP connection limits,
   ClientHello parse budget under SYN pressure, structured metrics
   (routes, streams, bytes, handshake failures), and graceful broker drain
   (nodes reconnect to a peer/new instance).
6. **Mobile-network survival measurements** (W1 checklist): stream behavior
   across LTE↔Wi-Fi transitions and NAT rebinding needs a real phone + a
   real NATed VM — not reproducible on localhost; scheduled with the M2
   hardening pass.

## Explicit non-goals of the spike

- No revocation checking on device certs (relayd extraction owns CRLs).
- Single node CA per relayd; no rotation.
- The broker trusts SNI for routing only — it can misroute ciphertext at
  worst; the node's mTLS rejects it.
- No config files, no daemonization, no logging framework.
