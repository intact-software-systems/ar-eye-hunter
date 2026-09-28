# Rallar Game Guide

Rallar Game keeps match truth on the server. Clients send commands. The server
publishes snapshots. Rallar Motion may interpolate those snapshots for display.
It must not advance the match.

`docs/architecture.md` records why each browser must not advance the match on
its own. Server mutations of match state go through AppInbox, as that document
describes.

## When to use it

Use the game layer when the product needs one winner, one score, or one world
that every client renders from the same published snapshot.

Do not use it for:

- collaborative notes or other authored documents, which belong in CRDT
- browser-local drafts, which belong in `rallar.data`
- cursors and other ephemeral presentation streams, which belong on a realtime
  data channel, then in Motion when the display should be smooth

## Where the recipe lives

`examples/server-authoritative-game/README.md` shows commands in and snapshots
out. `packages/shared-web/game/README.md` is the browser code map: match
lifecycle, envelopes, and egress. The director relay in
`examples/director-relay/README.md` forwards director-owned traffic. That relay
is not match authority. Presentation smoothing is
`docs/rallar-motion-guide.md`.
