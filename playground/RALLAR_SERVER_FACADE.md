# Rallar Server Facade Proposal

This proposal describes how Rallar can expose a server-side facade over the
current WebSocket, middleware-state, and REST API implementations.

The short version: Rallar already has enough transport primitives for
user-defined WebSocket topics. What is missing is a first-class server facade
that owns topic registration, schema validation, authorization, filtering,
proxying, and the boundary between Rallar middleware data and app-owned data.

## Current Implementation Boundary

The reusable server facade lives in `packages/shared-server/rallar-facade`, and
reusable Rallar middleware server behavior lives in
`packages/shared-server/rallar-system`. These packages own the generic
`RallarServer` facade, the dynamic WebSocket topic router, topic registration,
lightweight validator callbacks, NACK handling, proxy rules, configurable
fanout, repository lookup via `RepositoryManager`, server cache bootstrap, state
sync publishing, default system WebSocket topics, runtime-state abstractions, and
Rallar server state repositories for clients, groups, auth sessions, and auth
users.

`apps/api-v1` stays as the application adapter. It wires Hono routes, the
existing middleware runtime, shared default middleware topic installation,
WebSocket lifecycle callbacks, and API-specific room authorization. This keeps
server-neutral Rallar facade code out of the REST app while still allowing
`api-v1` to expose:

- `rallar.system` for middleware topic and lifecycle installation
- `rallar.ws` for user-defined topic registration, handlers, proxying, and route
  mounting
- `rallar.data` for shared repository lookup and lifecycle
- `rallar.rest` for Hono REST route mounting

## Current State

Rallar's application-layer message format already separates routing from
schema/message identity:

- `route.topicId` is the subscription and routing domain.
- `payload.typeId` is the schema or message type identifier.
- `route.contextId` represents a room, client, world, or application scope.
- `route.resourceId` identifies the specific domain resource or event.

The browser facade exposes this through `rallar.messages.ws.send()`:

```ts
await rallar.messages.ws.send({
  topicId: "room.cursor",
  typeId: "cursor.position.v1",
  roomId,
  payload: { x, y },
});
```

Subscriptions can filter by `topicId`, `typeId`, or both:

```ts
const unsubscribe = rallar.messages.ws.onMessage(
  { topicId: "room.cursor", typeId: "cursor.position.v1" },
  (message) => {
    console.log(message.payload);
  },
);
```

On the server, `api-v1` already initializes fixed Rallar middleware topics such
as clients, groups, graphs, RTT, chat, and RTC signaling. It also initializes a
dynamic topic router. The first server facade pass keeps user-defined topics to
these prefixes:

- `app.`
- `room.`

`rallar.*` is reserved for system middleware topics.

The dynamic router currently performs simple checks:

- reject reserved Rallar middleware topics
- reject topics outside the allowed prefixes
- reject messages without explicit targets
- reject oversized payloads
- authorize room-scoped messages against active group membership
- proxy accepted messages to resolved WebSocket targets

This means user-defined WebSocket fanout exists today. The first facade pass now
adds a registered, validator-aware, policy-driven API around that transport.

## Proposed Boundary

Introduce a server-side facade that becomes the composition root for:

- WebSocket server transport
- QueueBox inbox/outbox processing
- Rallar middleware state
- user-defined WebSocket topics
- server-side repositories
- REST route registration
- lifecycle hooks
- authorization/session context

The facade should not replace the lower-level implementations. It should wrap
them and make their roles explicit.

```ts
const server = createRallarServer({
  repositories,
  auth,
  websocket,
  rest,
});

server.system.useDefaultMiddlewareTopics();

server.ws.defineTopic({
  topicId: "room.cursor",
  typeId: "cursor.position.v1",
  scope: "room",
  validate: isCursorPosition,
  authorize: isRoomMember,
});

server.ws.on(
  { topicId: "room.cursor", typeId: "cursor.position.v1" },
  async (message, context) => {
    await context.proxy.toRoom(message.route.contextId, message);
  },
);

server.rest.mount(app, { prefix: "/api" });
server.ws.mount(app, { path: "/api/ws/:sessionId" });
```

## Facade Shape

The facade can be split into sibling surfaces.

### `server.system`

Owns Rallar middleware topics and state flows:

- clients
- client sessions
- groups
- group presence
- overlays
- graphs
- RTT
- RTC signaling
- WebSocket lifecycle

This surface should reserve system namespaces such as fixed `AppTopics` and
possibly `rallar.*`.

### `server.ws`

Owns WebSocket topic registration and message flow:

- define user topics
- validate payloads by `typeId`
- authorize messages before fanout
- filter messages before handlers run
- proxy messages to peers, rooms, world, or all clients
- expose low-level AL message hooks for advanced use
- decide whether a message is live-only or durable through QueueBox

The current dynamic router can become the default implementation behind this
surface, but it should be registry-backed rather than prefix-only.

### `server.data`

Owns server-side repository lookup and lifecycle:

- Rallar middleware repositories
- optional app-owned server repositories
- `RepositoryManager` lookup
- disposal and replacement
- per-runtime repository scoping

This should reuse `packages/shared/cache/**` and `RepositoryManager`, just like
the existing shared state repositories do.

### `server.rest`

Owns HTTP route registration and REST command/query behavior.

The REST API should not be inside the WebSocket facade. It should be a sibling
surface inside the broader Rallar server middleware facade. REST and WebSocket
should share the same repositories, auth/session model, and state services.

## Where `api-v1` REST Fits

The current `api-v1` REST API is already part of the server middleware in
practice:

- `apps/api-v1/src/main.ts` creates the middleware once.
- WebSocket topics and lifecycle are initialized from that middleware.
- REST routes are registered in the same process.
- REST route handlers use the same server-side state services and repositories.

Conceptually, REST should be the command/query plane:

- login and register
- API config lookup
- WebSocket ticket issuance
- ICE server lookup
- client state reads and writes
- group state reads and writes
- presence commands
- graph reads

WebSocket should be the event and fanout plane:

- state snapshots
- state events
- dynamic user-topic fanout
- RTC signaling
- server-to-client notifications

RTC remains the low-latency peer data plane.

So yes, `api-v1` REST can be part of the Rallar server middleware, but it should
be modeled as a sibling adapter, not as a child of the WebSocket facade.

The target architecture is:

```txt
RallarServer
  auth/session context
  RepositoryManager
  QueueBox/runtime stores
  system middleware services
  REST facade
    config routes
    auth routes
    client state routes
    group state routes
    graph routes
    WebSocket ticket route
  WebSocket facade
    system topics
    user topics
    filtering/proxying
  RTC facade
    signaling
    overlay multicast
    realtime data channels
```

REST routes should become thin adapters:

```ts
app.put("/api/state/clients/:id", async (c) => {
  const context = await server.auth.requireRequestContext(c.req);
  const body = await c.req.json();

  const snapshot = await server.system.clients.upsert(body, context);

  await server.system.events.publishClientSnapshot(snapshot, context);

  return c.json(snapshot);
});
```

That keeps the business operation in the Rallar server services, while Hono only
handles HTTP binding, request parsing, and response formatting.

## Topic Registry

The server facade should define topics explicitly:

```ts
type RallarServerTopicDefinition<T> = Readonly<{
  topicId: string;
  typeId: string;
  scope: "app" | "room" | "world";
  validate?: (
    value: unknown,
    context: RallarServerMessageContext,
  ) => boolean | Promise<boolean>;
  authorize?: (
    message: ALMessage,
    context: RallarServerMessageContext,
  ) => boolean | Promise<boolean>;
  maxPayloadBytes?: number;
  fanout?: "live-only" | "outbox" | "none";
}>;
```

`topicId` should answer "where does this route?".

`typeId` should answer "what schema/version is this payload?".

Recommended naming:

```txt
topicId: app.todo
typeId: todo.item.updated.v1

topicId: room.cursor
typeId: cursor.position.v1

topicId: room.chat
typeId: chat.message.v1
```

## Filtering And Proxying

Filtering should happen on the server before fanout when possible.

The current client-side `onMessage()` selector is useful, but it is not enough
for server-side policy because the client still receives anything the server
fans out. The server facade should support:

- topic/type filters
- sender filters
- room membership filters
- recipient filters
- payload filters
- transform/proxy functions
- drop reasons for rejected messages

Example:

```ts
server.ws.proxy({
  from: { topicId: "room.cursor", typeId: "cursor.position.v1" },
  authorize: ({ sender, room }) => room.hasSession(sender.sessionId),
  targets: ({ message }) => ({
    mode: "broadcast",
    scope: "room",
    exceptPeerIds: [message.id.senderId],
  }),
  suppressDefaultFanout: true,
});
```

## Implementation Plan

1. Create a `RallarServer` or `RallarServerMiddleware` module in `apps/api-v1`.
2. Move the existing middleware initialization behind that module.
3. Move fixed WebSocket topic setup behind `server.system.useDefaultTopics()`.
4. Replace the prefix-only dynamic router with a registry-backed topic router.
5. Keep a compatibility path for `app.*` and `room.*` dynamic topics.
6. Add schema validation hooks keyed by `typeId`.
7. Add server-side selector matching by `topicId` and `typeId`.
8. Move REST route registration behind `server.rest.mount(app)`.
9. Refactor REST handlers into thin adapters over server services.
10. Add tests for system topic isolation, user topic routing, auth rejection,
    payload validation, and REST-to-event publication.

## Work Estimate

Small cleanup, 1 to 2 days:

- document the existing dynamic topic support
- add tests around allowed prefixes and room authorization
- clarify `topicId` versus `typeId`

Moderate facade, 3 to 5 days:

- add a server facade over existing WebSocket services
- add topic definitions
- add selector-based handlers
- add filtering and proxy hooks
- route dynamic topics through the registry

Full server middleware shape, 1 to 2 weeks:

- fold REST route registration into the facade
- refactor REST handlers into service adapters
- add schema validation
- formalize system versus user topic namespaces
- add repository lifecycle and lookup through `RepositoryManager`

Durable app data flows, 2 to 4+ weeks:

- persistence/replay for custom server data flows
- durable fanout semantics
- backpressure and rate limits
- metrics
- multi-node proxying behavior
- operational controls

## Resolved Decisions

- `rallar.*` is reserved for system middleware topics.
- User code cannot define custom topic prefixes in the first pass. User topics
  are limited to `app.*` and `room.*`.
- Schema validation uses lightweight validator callbacks.
- Rejected WebSocket messages send AL NACK control messages back to the sender
  when possible. NACK send failures are logged only.
- User topic fanout is configurable per topic or publish call: `live-only`,
  `outbox`, or `none`.
- Overlays remain browser-side derived state for now.

## First Pass Implemented

The first pass creates the facade as a thin wrapper around the current
`WsQueueBoxServerService`, `JsonWebSocketServer`, and route registration. It
keeps existing behavior intact while moving dynamic user-topic routing behind a
registry-backed API.

That gives Rallar a clean public server shape without rewriting the transport or
persistence internals.
