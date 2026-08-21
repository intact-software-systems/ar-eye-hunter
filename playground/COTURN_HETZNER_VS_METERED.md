# Coturn On Hetzner Vs Metered TURN

Findings captured on 2026-06-25. Re-check pricing before committing to an operational budget.

## Summary

Self-hosting `coturn` on Hetzner is viable and likely much cheaper once TURN traffic grows beyond
free prototype usage, especially for Europe-heavy peers. Metered remains better for zero-ops global
fallback, dynamic routing, firewall compatibility, and managed availability.

Recommended path:

1. Keep Metered Open Relay as the low-friction default while traffic is tiny.
2. Add one Hetzner EU `coturn` server for controlled testing.
3. Return both Hetzner and Metered ICE servers, with Metered as fallback.
4. Move to multiple self-hosted regions only after traffic and user geography justify the extra ops.

## Current Metered Baseline

Metered has two relevant free/entry paths:

- Open Relay: 20 GB/month free TURN usage, global routing, STUN/TURN, UDP/TCP, ports 80/443, and
  `turns` support.
- Metered TURN pricing page: free trial is 500 MB/month. Paid Growth is $99/month for 150 GB, then
  $0.40/GB overage. Business is $199/month for 500 GB, then $0.20/GB. Enterprise is $499/month for 2
  TB, then $0.10/GB.

Metered TURN usage is calculated as ingress plus egress. That means a relayed media/data flow can
count both directions through the relay.

## Hetzner Cost Shape

For a Europe-heavy Rallar deployment, a small Hetzner EU Cloud Server is enough to start:

- CX23 in EU with IPv4: EUR 5.99/month from Hetzner's public price API.
- Breakdown: EUR 5.49/month server plus EUR 0.50/month IPv4.
- Included traffic: Hetzner docs list 20 TB/month for CX/CPX/CAX Cloud Servers in EU.
- Overage: Hetzner traffic docs state EUR 1/TB, billed in 100 MB blocks.
- Billing model: Hetzner Cloud bills outgoing traffic. Incoming and internal traffic are free.

The accounting difference matters: Metered counts ingress plus egress, while Hetzner Cloud bills
outgoing traffic. For symmetric TURN-relayed traffic, Hetzner's billable egress can be materially
lower than a provider metric that adds both ingress and egress.

US and Singapore Hetzner Cloud locations have lower included traffic depending on plan. A US CPX11
check showed EUR 17.99/month / USD 21.09/month, so global self-hosting is still possible but no
longer as absurdly cheap as one EU node.

## Pros Of Self-Hosting

- Very low fixed cost for EU traffic.
- Large EU included traffic allocation compared with free managed TURN tiers.
- Full control over auth, credential lifetime, domains, TLS, logs, metrics, rate limits, and allowed
  relay ranges.
- No dependency on Metered's credential API for normal operation.
- Standard WebRTC integration: the app only needs to provide `iceServers`.
- Good fit if most AR Eye Hunter / Rallar peers are in Norway or nearby Europe.

## Cons Of Self-Hosting

- One Hetzner VM is a single point of failure unless we run more than one.
- We own patching, monitoring, TLS renewal, abuse response, and traffic alerts.
- A misconfigured TURN server can become an open relay. That must be avoided.
- Global latency is worse than a managed globally routed TURN service unless we operate multiple
  regions.
- Corporate firewall traversal needs extra setup. Metered already provides 80/443 and `turns`;
  coturn can do this, but it needs careful port, certificate, and possibly dedicated-IP planning.
- Hetzner's Cloud SLA is lower than Metered's advertised high-tier SLA, and Hetzner credits are tied
  to the affected server's cost.

## Coturn Deployment Notes

Minimum safe shape:

- Run `coturn` on Ubuntu/Debian using the distro package or the official Docker image.
- Do not run an anonymous relay.
- Use TURN REST-style time-limited credentials from the Rallar backend:
  `username = expiryTimestamp:userId`, `credential = HMAC(secret, username)`.
- Open UDP/TCP 3478, TLS 5349, and optionally TLS-over-443 for restrictive networks.
- Set a bounded relay port range and open that range in the Hetzner firewall. A smaller range is
  easier to operate; a larger range supports more concurrent allocations.
- Configure `realm`, `server-name`, `fingerprint`, `lt-cred-mech`, `use-auth-secret`,
  `static-auth-secret`, certificates for `turns`, and clear log/metrics forwarding.
- Monitor allocations, bandwidth, failed auth, process health, disk logs, and Hetzner traffic usage.

Example ICE ordering during rollout:

```ts
const iceServers = [
    {
        urls: [
            'turn:turn-eu.example.com:3478?transport=udp',
            'turn:turn-eu.example.com:3478?transport=tcp',
            'turns:turn-eu.example.com:5349?transport=tcp'
        ],
        username,
        credential
    },
    ...meteredFallbackIceServers
];
```

## Recommendation For Rallar

For a prototype or private playtest, keep Metered Open Relay until usage or control needs outgrow
it.

For a serious EU-focused test deployment, add one Hetzner EU coturn instance and keep Metered as
fallback. That gives us a cheap primary path while preserving a managed escape hatch for networks or
outages the first self-hosted node cannot handle.

For global production, choose between:

- Managed TURN as the primary path if ops time is scarce and global reach matters.
- Multi-region coturn if traffic volume is high enough that managed TURN pricing dominates
  infrastructure cost.

## Sources Checked

- https://www.metered.ca/pricing/
- https://www.metered.ca/tools/openrelay/
- https://github.com/coturn/coturn
- https://docs.hetzner.com/robot/general/traffic/
- https://docs.hetzner.com/cloud/billing/faq/
- https://www.hetzner.com/cloud/cost-optimized/
- https://website-price-api.hetzner.com/api/v1/products/CLOUD_132%2BCLOUD_21
- https://website-price-api.hetzner.com/api/v1/products/CLOUD_121%2BCLOUD_21
