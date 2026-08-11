# Relay — live infrastructure notes (control plane + broker)

> Hostnames and IPs are genericized here (`<router-ip>`, `<router-host>`,
> `<node-id>`). Live values are recorded outside the repo. Measurements below
> are from an actual run over the public internet on 2026-08-09, not localhost.

## What is deployed

A single EC2 host (`relay-router`, ap-south-1, Ubuntu 24.04 x86_64) runs both
control-plane processes as systemd units. It is deliberately separate from the
personal agent box, which is untouched.

| Unit | Binds | Runs as | Source |
|---|---|---|---|
| `relay-broker` | `0.0.0.0:443` (SNI passthrough), `0.0.0.0:80` (node tunnel) | `relaybroker` | `product/broker`, cross-compiled `GOOS=linux GOARCH=amd64`, static, stdlib-only |
| `relay-cloud` | `127.0.0.1:8790` (loopback only) | `relaycloud` | `product/cloud`, Node 22, zero dependencies |

Both units are hardened the same way: dedicated system user, `NoNewPrivileges`,
`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`,
restricted address families, memory/task caps, `Restart=always`. The broker gets
`AmbientCapabilities=CAP_NET_BIND_SERVICE` instead of running as root, so
binding 80/443 costs no privilege beyond that one capability.

Secrets (`SESSION_SECRET`, `ADMIN_TOKEN`, `BROKER_TOKEN`) are generated **on the
box** with `openssl rand` into `/etc/relay-cloud/cloud.env` (`0640`,
`root:relaycloud`). They were never transmitted from a laptop, never printed to
a terminal, and never written to the repo.

### Ports and why

Ports 80 and 443 are the only inbound ports the security group allows besides
SSH (pinned to a single IP). The broker uses 443 for the data path and 80 for
the node tunnel. Port 80 carries the tunnel's raw framed protocol, not HTTP —
this is a spike convenience, and production moves the tunnel to `wss://` on 443
alongside the passthrough, distinguished by ALPN or a dedicated hostname.

## SNI routing without a domain

`sslip.io` resolves `<anything>.<dashed-ip>.sslip.io` to that IP for free, so
`<node-id>.<dashed-router-ip>.sslip.io` gives real, publicly-resolvable
per-node hostnames before any domain is purchased. The broker is started with
that suffix and strips it to recover the node id. When the product domain
lands, only the suffix changes — no protocol change.

## Measured over the public internet

Node ran behind NAT on a laptop (dialing out only, zero inbound ports); broker
on EC2; client on the same laptop reaching the public IP. Round-trip to the
region was ~87 ms, which sets the floor for everything below.

| Measurement | Result |
|---|---|
| mTLS `GET /healthz` through the tunnel | **HTTP 200**, 541 ms cold |
| New connection, p50 / p95 total | 398 ms / 1088 ms (each includes a full mTLS handshake) |
| TCP connect p50 | 87 ms (one RTT — the network floor) |
| mTLS handshake p50 | 122 ms on top of connect |
| **Reused connection, per request** | **~130 ms — roughly one RTT** |
| SSE, 15 events emitted 200 ms apart | All 15 arrived incrementally, span 2.76 s, per-event delivery 49–87 ms |
| 5 concurrent SSE streams over one tunnel | 15/15 events each, no interleaving loss |
| Client with no certificate | TLS alert 1116 `certificate required`, raised **by the node** |
| Unknown SNI | Connection dropped at the broker, no ServerHello |

Two findings matter for the product:

**Connection reuse is worth ~270 ms per request.** A cold request costs ~400 ms
because it pays TCP + mTLS through the tunnel; a reused one costs ~130 ms. The
iOS client must hold one warm `URLSession` connection per node rather than
letting it idle out, or every screen transition pays the handshake again.

**SSE genuinely streams end to end.** Events arrived spread across the full
2.76 s span with 49–87 ms delivery latency, so nothing in the path (mux,
passthrough splice, kernel buffers) accumulates a stream before flushing it.
This was the main open question behind the passthrough design and it is now
answered on real infrastructure, not loopback.

## Node reconnect is a launch blocker (proven, not theorized)

Restarting the broker killed the spike node: it logged `mux: read: EOF` and the
**process exited**. Every subsequent request failed at the broker with no route.
A broker restart, a network blip, or an idle-timeout eviction would therefore
take a user's node permanently offline until someone manually restarted it.

The spike node has no reconnect logic by design (documented deviation). The
production node client must dial back with exponential backoff and jitter and
re-register automatically; a node that cannot survive a broker restart cannot
ship. This is the highest-priority item carried out of the tunnel work.

## Robustness probes against the live broker

Malformed input did not disturb it: an HTTP request to the tunnel port, 100 KB
of random bytes to the tunnel port, non-TLS junk to the passthrough port, a
plain HTTP request to 443 (reset by peer, correct), and 50 rapid concurrent
connections all left the broker healthy, with the tunnel still serving 200s
afterward. An idle tunnel survived quiet periods of 5, 10 and 15 minutes with
no reconnect events in the node log — the 15-second heartbeat holds the path
open across the real network, through NAT, without a load balancer in between.

Two things the probes exposed that production must change:

**The tunnel port fingerprints itself.** Any TCP connection to it, from anyone,
immediately receives `{"v":1,"challenge":"..."}` before authenticating anything.
A scanner learns exactly what is running. Moving the tunnel to `wss://` on 443,
selected by ALPN or hostname, hides it behind an ordinary TLS handshake and
removes the port-80 listener entirely.

**Nothing rate-limits connection setup.** Each connection costs a goroutine and
a random challenge held for the 10-second auth window, with no per-IP cap. The
existing M2 note about per-node/per-IP limits now has a concrete shape: the cap
belongs at accept time, before the challenge is generated.

## Verified on the box

- `product/cloud` test suite: **16/16 pass** on the target host (Node v22.23.2,
  Ubuntu 24.04) — confirms the zero-dependency and built-in-SQLite bet holds on
  the real platform, not just macOS.
- Control-plane routes exercised live: waitlist accepted (202), magic-link
  request accepted (202), `/v1/admin/nodes` returns 401 without the admin token
  and 200 with it, the broker registry hook returns 401 without the broker token
  and 404 for an unknown node.

## Fresh-VM install gate

An LXD container on the same host (Ubuntu 24.04, systemd running, no Node
preinstalled) stands in for a customer's fresh VM, with a `pristine` snapshot
that restores in seconds. Running `install.sh` there is the only check that
exercises what a new user actually experiences, and it has earned its keep: the
first execution found five defects, including a pairing code that could never
be redeemed, and a later run found a sixth that no unit test could see.

The gate now passes end to end — install, pair, authenticate:

| Step | Result |
|---|---|
| `install.sh` on a pristine VM | exit 0, "INSTALLED AND READY", daemon active |
| Listeners | `127.0.0.1:8787` (mTLS data) + `127.0.0.1:8788` (pairing) |
| `relayd pair` in one process, redeemed by the **daemon** in another | HTTP 201 with certificate + node CA |
| Response authenticated | node-side HMAC tag verifies |
| Replay the same code | 403 |
| Cloud swaps the blob (substitution attack) | 403 `pairing blob authentication failed`, audited |
| `/v1/pair` on the mTLS data listener | 404 — never served there |
| Paired device presents its subject | **200** |
| Unknown subject / no client cert | 403 / 401 |

Two of those rows were failures the first time. The pairing session used to live
in the CLI process's memory and died when it exited, so the printed code was
already dead. And the paired subject was allowlisted in OpenSSL's display
encoding while callers present RFC 2253, so a device that had just paired was
immediately locked out — a 403 that no unit test could see, because each side
was internally consistent.

## Not yet done

- The broker still registers nodes from command-line flags; it does not call the
  cloud registry hook, which exists and is tested on the cloud side.
- No `wss://` transport, flow control, metrics, or connection draining.
- Control plane is loopback-only: no domain, no TLS front, no public exposure.
- No phone on a cellular network has traversed this path yet, and no
  Wi-Fi↔cellular handoff has been measured.
