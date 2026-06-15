# Rallar Examples

These examples are small copyable recipes for the current Rallar package
surfaces. They are documentation examples, not standalone apps.

## Browser Facade

- [Browser Startup And Room](./browser-startup-room/README.md): configure the
  browser facade, restore/login, create a funny RallarAI room name, join it, and
  subscribe to room/people state.
- [Room Realtime Channel](./room-realtime-channel/README.md): use
  `rallar.realtime.room<T>(...)` for low-latency room-scoped RTC traffic.
- [Room Message Channel](./room-message-channel/README.md): use
  `rallar.messages.room<T>(...)` for typed room messages with RTC and WS
  options.
- [Director Relay](./director-relay/README.md): route client intents and
  director outputs through the current room director appointment.
- [Media Calls](./media-calls/README.md): start targeted data/media calls,
  handle invites, and attach microphone/camera/screen sources.

## Product Helpers

- [Browser Data Store](./browser-data-store/README.md): persist local
  latest-value browser state through `rallar.data`.
- [Room CRDT Document](./room-crdt-document/README.md): open a room-scoped CRDT
  document for collaborative authored state.
- [Motion Smoothing](./motion-smoothing/README.md): smooth received snapshots
  with Rallar Motion and gate high-rate pose sends.

## Server And AI

- [Server Middleware](./server-middleware/README.md): compose
  `createRallarMiddleware` and the server facade.
- [RallarAI Game Event](./rallar-ai-game-event/README.md): treat generated game
  content as proposal data until validated and accepted.
- [RallarAI Server With Ollama](./rallar-ai-server-ollama/README.md): keep a
  local Ollama provider private behind a server-side RallarAI flow.

## Guidance

Use the full browser facade from `@shared-web/browser/rallar.ts` when an app
needs several Rallar surfaces. Use narrower entry points such as
`@shared-web/browser/rallar-realtime.ts`, `rallar-data.ts`, `rallar-crdt.ts`, or
`rallar-media-calls.ts` when building a smaller bundle-specific integration.
