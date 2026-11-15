# CCA 2D playable practice

Phaser 3.90 renders Pocket Arcade Market. The practice slice supports movement,
dash, automatic coin pickup and a continuous 0.9-second bank hold. The control
deck occupies the bottom quarter of a portrait viewport; the world stays square.
Keyboard: WASD/arrows, Space to dash, E to bank. Touch: joystick, Dash, hold Bank.

## Run

```sh
npm ci
npm --workspace cca-2d run dev
```

Open the Network URL printed by Vite on a phone on the same LAN. Solo practice
needs no account or server. The scene uses four generated WebP assets and lazy
loads Phaser. Art is single-frame; full animation and sound remain future work.

For multiplayer, run [cca-server](../cca-server/README.md), then choose Play with
a friend. Sign in, create a room by leaving its code empty, and share the URL or
room code with a second account. Maximum two live runners. On one computer, use separate browser profiles for
separate accounts; tabs share Rallar sign-in state. Use HTTPS for remote
multiplayer: Rallar's browser authentication requires secure browser APIs.

The first network slice is ephemeral practice: no guard, countdown, winner,
leaderboard or durable result. Server restart loses the practice state and requires
re-entering. A disconnected input expires within 250ms; an inactive seat expires
after ten seconds. Re-entering after expiry starts a new runner and score.

## Owners and lifecycle

- `src/main.ts`: landing page, lazy startup, sign-in and teardown.
- `src/market-app.ts`: HUD and Phaser lifetime.
- `src/market-input.ts`: independent touch pointers, keyboard, cancellation.
- `src/market-scene.ts`: assets and rendering only.
- `src/market-session.ts`: fixed-step local practice.
- `src/online-market.ts`: scoped Rallar input and server snapshots.
- `../../packages/cca-game`: the same pure rules on browser and server.
- `../cca-server/src/market-authority.ts`: bounded rooms, authenticated input,
  input expiry, simulation and server-only snapshot publication.

Construction creates controls and a session before the Phaser scene. Phaser calls
scene updates; those advance local rules or submit live input and project accepted
state. Rallar installs the snapshot listener before the first input send. Stops
abort DOM listeners, unsubscribe snapshots and destroy Phaser. Room authorization
and audience resolution remain Rallar-owned; the game creates no raw socket.

## Checks

```sh
npx vitest run packages/tests/cca-game
npm --workspace cca-2d run build
npm --workspace cca-server run typecheck
```

See `projects/cca-2d` for the intended complete game and release qualification.
These first-playable capabilities do not certify physical-device comfort,
network impairment, competitive fairness or production hosting.

## First-slice visual and transfer limits

At 390 × 844 CSS pixels, the world is 366-square and the control deck is 211 pixels
high. The joystick is 112 pixels; both action buttons are 72 pixels. This is browser
viewport evidence, not physical touch comfort qualification.

The shell lazy-loads Phaser and separately loads the online Rallar adapter. Initial
build sizes are approximately 321 KiB gzip for the game/Phaser chunk and 381 KiB for
the online chunk, plus 1.98 MiB of WebP seed art. This exceeds the proposed 2 MiB
first-playable transfer budget; production texture normalization remains necessary.
