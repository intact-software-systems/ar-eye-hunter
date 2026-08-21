# Rallar AI Prompting Guide

Use these prompt patterns when asking an AI to build, review, or debug code that uses Rallar, Rallar Data, or Rallar Server.

## General Prompt Shape

Give the AI:

- The target files.
- Whether code changes are allowed.
- The intended Rallar surface: auth, rooms, people, WS, RTC, realtime, data, media, or server middleware.
- The application/workspace/room assumptions.
- Whether real browser/server tests are required.
- Any resilience or lifecycle requirements.

Template:

```text
Read these files first:
- packages/shared-web/browser/rallar.ts
- packages/shared-web/browser/rallar-data.ts
- packages/shared-server/rallar-system/middleware/RallarMiddleware.ts

Task:
Implement [feature] using the Rallar facade.

Constraints:
- Use rallar.setDefaults({ applicationId: ..., workspaceId: ... }) where possible.
- Prefer roomRef over roomId when scope matters.
- Wait for WS/RTC readiness before sending.
- Add tests first, then code changes, then more tests.
- Do not bypass the facade unless there is no facade API.
```

## Required AI Completion Contract

Close task work with a teammate-style handoff containing:

- What was done (changed files/behavior, one-sentence summary).
- Why it was done (compatibility, scope, and tradeoff rationale).
- Evidence (verification commands and exact results: pass/fail/skip).
- What should happen next (optional follow-up or risk monitoring).

Keep it concise and explicit, especially when decisions are risky (major
version upgrades, compatibility workarounds, or temporary mitigations).

## Browser App Prompts

### App Startup

```text
Implement browser startup using Rallar.

Requirements:
- Configure the API base URL before connecting.
- Set defaults for applicationId and workspaceId.
- Restore an existing session.
- Connect WS.
- Refresh rooms and people.
- Expose connection status to the UI using rallar.ws.onStatus and rallar.rtc.onStatus.
- Add tests for logged-in and logged-out startup.
```

Expected API use:

```ts
await rallar.setup({
    apiBaseUrl,
    applicationId,
    workspaceId,
    start: {
        refreshPeople: true
    }
});
```

### Auth Flow

```text
Implement login/logout through Rallar auth.

Requirements:
- Use rallar.auth.login and rallar.auth.logout.
- Do not call lower-level API integration functions directly.
- After login, call rallar.start with refreshRooms and refreshPeople.
- On logout, ensure UI subscriptions and authenticated data scopes are cleaned up.
- Add tests for successful login, failed login, logout, and restored session.
```

### Room Workflow

```text
Implement room list, create, join, leave, and current room display using Rallar rooms.

Requirements:
- Use rallar.rooms.refresh for initial load.
- Use rallar.rooms.createAndSwitch when a new room should replace the current
  room; use rallar.rooms.create only when the browser should stay in both.
- Use rallar.rooms.join, leave, current, and session for existing/current room
  flows.
- Use rallar.rooms.waitForPresence when UI or game setup depends on active
  session counts.
- Subscribe with rallar.rooms.onChange.
- Use rallar.rooms.onEvent for state-sync events.
- Prefer configured defaults and GroupRef.
- Add tests around current room transitions and leaving previous room.
```

### People Presence

```text
Implement people/presence UI using Rallar people.

Requirements:
- Use rallar.people.refresh and rallar.people.onChange.
- Use rallar.people.onEvent for client state events.
- Display online status from RallarPerson.isOnline and activeSessionCount.
- Add tests for presence updates after state-sync events.
```

## Messaging Prompts

### WS Room Messages

```text
Implement server-routed room chat over Rallar WS messages.

Requirements:
- Use rallar.messages.ws.onMessage for incoming chat.
- Use rallar.messages.ws.send for outgoing messages.
- Include topicId and typeId.
- Use scope: 'room' and roomRef when sending.
- Handle send status and display failures.
- Add tests for selector matching and send result handling.
```

Expected API use:

```ts
rallar.messages.ws.onMessage(
    { topicId: 'room.chat', typeId: 'chat.message.v1' },
    (message) => handleChat(message.payload)
);

await rallar.messages.ws.send({
    topicId: 'room.chat',
    typeId: 'chat.message.v1',
    payload: { text },
    scope: 'room',
    roomRef
});
```

### RTC Realtime Messages

```text
Implement low-latency peer updates over Rallar realtime.

Requirements:
- Use rallar.realtime.room<T>({ roomId: room, laneId: 'realtime', waitTimeoutMs: 1000 }) for room-scoped app/game sends.
- Check the returned room send status and diagnostics.
- Use rtc.waitForRoomLane(..., { expect }) only for low-level peer targeting or
  custom readiness diagnostics.
- Use rallar.messages.room<T>(...) when important messages need typed RTC/WS fallback behavior.
- Add tests for open, partial, timeout, over-capacity, and no-peer readiness.
```

### Typed Message Channel

```text
Wrap a domain payload in a typed Rallar message channel.

Requirements:
- Use rallar.messages.channel<T> with a stable topicId/typeId.
- Expose sendWs, sendRtc, onWs, and onRtc through a small domain module.
- Add tests that verify topic/type selectors and payload forwarding.
```

## Rallar Data Prompts

### Persistent Drafts

```text
Implement browser-local drafts using Rallar Data.

Requirements:
- Define a typed store.
- Use scope: 'principal'.
- Use write-behind durability and lazy hydration.
- Listen with onChange.
- Flush or wait for idle before destructive navigation if needed.
- Destroy or close the principal scope on logout if the drafts are sensitive.
- Add tests for set, updateOrCreate, reload/hydrate, and deleteExpired.
```

Expected API use:

```ts
const drafts = await rallar.data.open<Draft>('drafts', {
    scope: 'principal',
    durability: 'write-behind',
    hydrate: 'lazy',
    sync: true
});
```

### Schema Migration

```text
Add a Rallar Data schema migration for an existing store.

Requirements:
- Increase schemaVersion.
- Provide migrate(persistedValue, context).
- Preserve unknown-but-valid fields only if the domain requires it.
- Add tests for old envelope migration and raw pre-envelope values.
```

## Server Prompts

### Middleware Setup

```text
Review or implement Rallar server middleware setup.

Requirements:
- Use createRallarMiddleware or createRallarServerApplication.
- Wire queuebox inbox/outbox.
- Wire AppGroupInboxService and AppClientInboxService.
- Wire state sync publisher.
- Provide findGroupSnapshotByRef for scoped room routing.
- Install default middleware topics and websocket lifecycle cleanup.
- Start qboxEngine.
- Add tests for route mounting and lifecycle cleanup.
```

### Server WS Topic

```text
Implement a Rallar Server websocket topic.

Requirements:
- Use rallarServer.ws.defineTopic or rallarServer.ws.on.
- Validate payloads.
- Authorize room messages using the room authorization path.
- Decide fanout: live-only, outbox, or none.
- Add tests for valid, invalid, unauthorized, and fanout behavior.
```

### App Data

```text
Implement a Rallar Server app data store.

Requirements:
- Use rallarServer.data.define/open.
- Define key structure and value schema.
- Decide whether compareAndSet is sufficient for this workflow.
- Add tests for set, updateOrCreate, compareAndSet, and persistence.
```

## Review Prompts

### Facade Review

```text
Review this Rallar browser usage.

Prioritize:
- Missing configure/setDefaults/start.
- Direct API calls where facade methods exist.
- Missing unsubscribe cleanup.
- First realtime send before RTC lane readiness.
- Use of roomId where roomRef is needed.
- Rallar Data stores opened with inconsistent options.
- Missing tests for disconnected, timeout, and partial-ready states.
```

### Server Review

```text
Review this Rallar Server usage.

Prioritize:
- qboxEngine not started.
- default topics or websocket lifecycle not installed.
- target resolver missing scoped group snapshot lookup.
- app inbox service not durable.
- state sync publish not routed through app inbox.
- missing real server/browser tests for lifecycle and routing.
```

## Debugging Prompts

### RTC Send Is Slow

```text
Analyze why the first rallar.realtime.room(...).send(...) takes several seconds.

Check:
- Whether the helper is waiting for RTC readiness and which status it returns.
- Whether connect: true is used by the wait options.
- Whether the room has active peer sessions.
- Whether laneId matches configured data channel lanes.
- Whether fallback to WS is needed on timeout or partial readiness.
```

### Messages Not Received

```text
Debug why Rallar messages are not received.

Check:
- topicId/typeId selector mismatch.
- WS open status.
- RTC lane status.
- roomRef/application/workspace mismatch.
- server target resolver group snapshot availability.
- active presence sessions in group snapshot.
- send result status and reason.
```

### Local Data Not Persisting

```text
Debug why Rallar Data values are not persisted.

Check:
- durability setting.
- hydrate mode.
- write-behind onPersistenceError.
- whenIdle or flush before closing.
- IndexedDB availability.
- ttlMs or expireAtFor deleting values.
- store opened with matching options.
```
