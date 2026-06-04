# Networking Foundations for Agent Payments

Summary of a hands-on deep-dive (2026-06-04) into Tailscale/WireGuard internals,
including building a real 3-node WireGuard network (laptop + phone + cloud VPS hub)
from scratch. Written as design input for the Termpay architecture rework.

---

## 1. How Tailscale-style networks actually work

Three independent layers, often conflated:

| Layer | Job | Who does it |
|---|---|---|
| Data plane | Encrypted point-to-point tunnel | WireGuard (open source, free) |
| Control plane | Key distribution, IP assignment, membership | Coordination server (Tailscale, Headscale, or DIY) |
| Reachability | NAT traversal (STUN-style discovery + UDP hole punching), relay fallback | Tailscale's DERP fleet, or a hub you run |

Key insight: the coordination server is only a **phone book**. It distributes public
keys and candidate addresses; actual traffic never touches it. The product Tailscale
sells is not the tunnel — it is the automation of key distribution and NAT traversal.

## 2. WireGuard fundamentals (from the protocol site + Donenfeld's CODE BLUE 2016 talk)

- **Cryptokey routing** — the core invention. One table maps `public key ↔ allowed
  tunnel IPs`. Identity, authentication, and routing collapse into a single mapping:
  a packet from tunnel IP X is *cryptographically guaranteed* to come from key X's owner.
- **Noise IK handshake** — mutual auth + session keys in 1 RTT. Rekey ~every 2 min
  (forward secrecy). Protocol is formally verified.
- **Abuse resistance** — silence by default: packets without a valid key get *no
  response* (invisible to port scans). Under load, a stateless cookie mechanism binds
  handshake retries to the sender's IP, defeating spoofed-source CPU exhaustion.
- **No negotiation** — fixed primitives (Curve25519, ChaCha20-Poly1305, BLAKE2).
  No downgrade attacks possible; ~4k LOC, single-person auditable.
- **Stateless roaming** — a peer's location is "wherever its last *authenticated*
  packet came from." Networks can change mid-session without dropping anything.
- **UDP only, by design** — tunneling TCP inside TCP causes retransmission-timer
  amplification ("TCP-over-TCP meltdown"). Exactly one layer should own reliability;
  for an IP tunnel, that layer is the inner protocol. Same reasoning as QUIC/HTTP3.
- Status: merged into Linux kernel 5.6 (2020); de facto standard for new VPN products
  (Tailscale, WARP, NordLynx, Mullvad). Deliberately *not* an IETF standard.

## 3. The key-distribution problem (and decentralized alternatives)

WireGuard explicitly scopes key distribution out. Options, in increasing decentralization:

1. **Manual pairwise exchange** — fine for 2–3 nodes; O(n²); painful on every address change.
2. **Trusted directory** (Tailscale / self-hosted Headscale) — members trust one
   roster; joining the roster = becoming "known" to all peers. The directory's real
   function is *access control*, not just key delivery.
3. **DHT, key = address** (Hyperswarm, iroh, libp2p) — the agent's identity IS its
   public key; peers find each other through a communal DHT. Only one string must be
   shared out of band. Tradeoff: dropping the directory drops access control — anyone
   who learns the topic/key can dial in, so add post-connect auth.

Hard limit: **zero rendezvous is impossible.** Two NATed peers with no prior knowledge
cannot find each other; *something* must introduce them (server, DHT, LAN broadcast,
or a human). You choose the introducer; you cannot eliminate it.

## 4. What we built (lab notes)

Topology: laptop (campus Wi-Fi, NATed) + phone (LTE) + cloud VPS with a public IP
as hub. Direct LAN p2p failed — enterprise Wi-Fi client isolation silently dropped
peer-to-peer UDP (no error, no handshake; `wg show` shows no `latest handshake` line).
Hub topology fixed it: both ends dial *out*, so no inbound blocking applies anywhere.

Operational lessons, each independently capable of killing the link:

- Cloud firewalls are layered: provider security list (blocks before the VM ever
  sees the packet — verify with tcpdump) AND host iptables (default-deny on Oracle
  Ubuntu rejected tunnel-borne TCP until `-i wg0 -j ACCEPT` was added).
- `wg show` reading: `interface:` = self, `peer:` = the other side; the `endpoint`
  field is the roaming mechanism made visible (last authenticated source address).
- Binding a service to the tunnel IP only (e.g. `--bind 10.x.x.x`) makes it
  reachable exclusively by key-holding peers — private-by-construction services.
- "Connected" toggles in clients mean *attempting*, not *handshaked*. The only truth
  is a recent `latest handshake` + nonzero rx bytes.

## 5. Latency physics

- Fiber carries light at ~200,000 km/s (2/3 c). Antipodes ≈ 20,000 km ⇒ theoretical
  RTT floor 200 ms; real routes ~300 ms+.
- **Path beats distance.** Our two same-city devices measured 287 ms RTT because
  packets detoured through the hub (~3,000 km round trip + LTE air interface).
  A direct path between the same devices would be 2–5 ms. This is why Tailscale
  fights so hard for p2p and treats relays as last resort.
- Latency is a *tax on every round trip*, not a one-time cost. A 300 ms RTT times
  10–20 round trips (TCP + TLS + app chatter) = multi-second interactions.
  Design protocols to minimize round trips (WireGuard's own 1-RTT handshake is the
  exemplar). Bandwidth is a separate axis: a high-latency path can still bulk-transfer fast.

## 6. Failure modes catalog

| Failure | Effect | Mitigation |
|---|---|---|
| Guest/corp Wi-Fi blocks outbound UDP | Tunnel dead (WireGuard has no TCP mode) | Listen on 443/udp; wrap in wstunnel; or TCP-relay fallback (DERP model) |
| Captive portal | Dead until browser login | Detect & surface to user |
| Hub down / hub IP changes (ephemeral cloud IPs) | Whole mesh dead — hub is a SPOF | Multiple relays; re-resolvable endpoints (DNS); p2p where possible |
| MTU mismatch | Eerie partial failure: ping works, big payloads hang | Clamp MTU (~1280) |
| DPI / national firewalls | WireGuard handshake is fingerprintable and actively blocked (e.g. GFW); obfuscation is an explicit non-goal | Out of scope; requires separate obfuscation layer |
| NAT mapping expiry on idle | Silent death after inactivity | PersistentKeepalive (25 s) |
| Mobile OS single-VPN limit (iOS) | Activating one tunnel kills another | Don't assume two meshes coexist on phones |

## 7. Money over unreliable channels

The pivotal reframe: **money never moves over the network — ledger-update
instructions do.** The network's unreliability is therefore an old, solved problem:

- Packet loss is trivial (inner TCP / app retries). The dangerous case is
  **ambiguity**: request sent, no response — did it execute? (Two Generals problem.)
- Standard resolution: **idempotency keys.** Every instruction carries a unique ID;
  the ledger executes each ID at most once; retries become harmless; "unknown
  outcome" resolves by reconciliation against the ledger, never by guessing.
- Signed blockchain transactions are the extreme form: validity lives in the
  signature, not the channel — broadcastable over any medium, idempotent by
  construction (a spent input cannot spend again). They are *designed* for hostile,
  lossy channels.
- Trillions of dollars already flow daily over the untrusted internet on exactly
  this principle: never trust the channel; trust signatures + the ledger.

## 8. Design implications for Termpay

1. **Identity = keypair.** Adopt the cryptokey-routing model: an agent's identity is
   its public key; authorization maps keys → allowed actions, the way WireGuard maps
   keys → allowed IPs. No bearer tokens as primary identity.
2. **Channel-agnostic payment messages.** Every payment instruction must be safe to
   carry over any transport: signed, uniquely identified (idempotency key), and
   harmless when duplicated or replayed.
3. **Timeout ≠ failure.** Treat unknown outcomes as a first-class state; resolve by
   querying the ledger (reconciliation), never by blind retry without an idempotency
   key, never by assuming failure.
4. **Minimize round trips.** Budget for 300 ms worst-case RTT (relayed, intercontinental).
   A payment flow needing 10 round trips is a 3-second flow. Aim for 1–2.
5. **Expect transport failure.** UDP-blocked networks, captive portals, dying relays,
   MTU traps. Any agent mesh needs a relay fallback (DERP lesson) and must surface
   "attempting" vs "connected" honestly (handshake-verified, not toggle-state).
6. **Silence as a security posture.** Don't respond to unauthenticated requests
   (WireGuard's abuse resistance). Unauthenticated traffic deserves no error messages.
7. **Rendezvous is unavoidable — choose it deliberately.** Directory (access control,
   centralized) vs DHT (decentralized, open). For payments, access control matters:
   a vetted-membership roster is a feature, not a compromise.
8. **Private-by-construction services.** Internal components (ledgers, dashboards,
   agent APIs) can bind to tunnel addresses only — reachable exclusively by
   key-holding peers, with zero public attack surface.
