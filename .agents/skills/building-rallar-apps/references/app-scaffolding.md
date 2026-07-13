# Rallar App Scaffolding

## Decisions Before Files

Decide these boundaries before choosing dependencies or creating files:

| Decision | Choose explicitly |
| --- | --- |
| Authority | Browser director for room-trusted outcomes, server authority for trusted outcomes, or CRDT for collaboratively authored truth. |
| Durable/shared/local state | Put match truth in Rallar Game or server domain code, authored documents in Rallar CRDT, and browser-local latest values in Rallar Data. |
| Latency/reliability | Use room messages for reliable or fallback coordination and room realtime for low-latency, replaceable traffic. |
| 3D renderer | Compare Direct Three.js, React Three Fiber, and Babylon against the scene shape, ownership needs, lifecycle cost, and measured browser budgets. |

Write down the authoritative state, accepted inputs, snapshot shape, transport
semantics, and presentation-only state for the first vertical slice.

## Recommended Repository Shape

Use this as an illustrative shape, not as a generator or a required new
package:

```text
apps/example-rallar-app/
  src/
    rallar/       # facade setup and concrete dependency adapters
    runtime/      # lifecycle, room handles, subscriptions, state projection
    ui/           # React routes, controls, low-frequency view state
    renderer/     # optional renderer adapter and presentation resources
  tests/          # app/runtime tests and visible browser coverage

packages/example-rallar-app/  # optional pure domain/protocol package
  src/
  tests/
```

Keep reusable domain rules and transport-neutral contracts in
`packages/example-rallar-app` only when another consumer or isolation benefit
justifies that package. Keep React, browser globals, renderer types, and Rallar
facades in the app.

## Initial Boot

Configure and start the facade once at the application boundary:

```ts
import { rallar } from '@shared-web/browser/rallar.ts';

const started = await rallar.setup({
    apiBaseUrl: 'http://localhost:8080',
    applicationId: 'example-rallar-app',
    workspaceId: 'default',
    start: {
        refreshPeople: true,
    },
});

if (!started.session) {
    await rallar.auth.login({
        username: credentials.username,
        password: credentials.password,
    });
    await rallar.start({
        connect: true,
        refreshRooms: true,
        refreshPeople: true,
    });
}
```

Use `rallar.setup(...)` once for initial API configuration, defaults, session
restore, connection, and room refresh. After a login on an already configured
facade, use `rallar.start(...)` to connect and refresh. Use
`rallar.rooms.enter(...)` to join and bind a room; use
`rallar.rooms.session(...)` only when the room is already current/known.

Do not replace initial `rallar.setup(...)` with a `configure`/`start` sequence.
Keep application and workspace defaults configured before connecting.

## Room-Bound Vertical Slice

Retain the scoped `roomRef` and derive traffic from the room session:

```ts
type ReadyMessage = Readonly<{ ready: boolean }>;
type PoseUpdate = Readonly<{
    seq: number;
    position: readonly [number, number, number];
}>;

const room = existingRoomRef
    ? await rallar.rooms.enter(existingRoomRef)
    : rallar.rooms.session((await rallar.rooms.createAndSwitch({
        displayName: 'Example Arena',
    })).group);
const roomRef = room.roomRef;

const ready = room.message<ReadyMessage>('ready');
const poses = room.realtime<PoseUpdate>({
    laneId: 'poses',
    maxAgeMs: 120,
});

const subscriptions = rallar.subscriptions();
subscriptions.add(ready.onWs((payload) => acceptReady(roomRef, payload)));
subscriptions.add(ready.onRtc((payload) => acceptReady(roomRef, payload)));
subscriptions.add(poses.on((message) => acceptPose(roomRef, message)));

await ready.send({ ready: true });
await poses.send({ seq: nextPoseSeq(), position: localPose() });
```

Use `rooms.createAndSwitch(...)` for the new-room branch, then bind its current
room once with `rooms.session(...)`. Use `rooms.enter(...)` as the alternative
existing-room branch; it joins and returns the bound session. Keep that session
and its `roomRef` together across application/workspace scope; do not reduce
identity to a bare room ID. Force `sendWs(...)` when an operation specifically
requires reliable server-routed coordination.

## Runtime Adapter

Keep facade and transport calls behind an injected lifecycle boundary. The
concrete adapter can use `rallar.start(...)` because the app boundary already
performed initial `rallar.setup(...)`.

```ts
import type {
    RallarRoomSession,
    RallarStartResult,
    RallarSubscriptionScope,
} from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export type RallarAppRuntimeDeps = Readonly<{
    start(signal: AbortSignal): Promise<RallarStartResult>;
    enterRoom(
        room: string | GroupRef,
        signal: AbortSignal,
    ): Promise<RallarRoomSession>;
    subscriptions(): RallarSubscriptionScope;
}>;

export class RallarAppRuntime {
    private subscriptions?: RallarSubscriptionScope;
    private controller?: AbortController;
    private generation = 0;
    private disposed = false;

    constructor(private readonly deps: RallarAppRuntimeDeps) {}

    async start(room: string | GroupRef): Promise<RallarRoomSession> {
        if (this.disposed) throw new Error('Runtime is disposed.');

        const generation = ++this.generation;
        this.controller?.abort();
        this.subscriptions?.unsubscribe();
        this.subscriptions = undefined;
        const controller = new AbortController();
        this.controller = controller;

        try {
            const started = await this.deps.start(controller.signal);
            this.assertActive(generation, controller.signal);
            if (!started.session || !started.connected) {
                throw new Error('Rallar session is not connected.');
            }

            const roomSession = await this.deps.enterRoom(
                room,
                controller.signal,
            );
            this.assertActive(generation, controller.signal);

            const subscriptions = this.deps.subscriptions();
            const status = roomSession.message<{ ready: boolean }>('ready');
            this.assertActive(generation, controller.signal);
            subscriptions.add(status.onWs((payload) => {
                if (this.isActive(generation, controller.signal)) {
                    publishRuntimeState(payload);
                }
            }));
            this.subscriptions = subscriptions;
            return roomSession;
        } catch (error) {
            if (!this.isActive(generation, controller.signal)) {
                throw new DOMException('Runtime lifecycle ended.', 'AbortError');
            }
            throw error;
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.generation += 1;
        this.controller?.abort();
        this.controller = undefined;
        this.subscriptions?.unsubscribe();
        this.subscriptions = undefined;
    }

    private isActive(generation: number, signal: AbortSignal): boolean {
        return !this.disposed && !signal.aborted && generation === this.generation;
    }

    private assertActive(generation: number, signal: AbortSignal): void {
        if (!this.isActive(generation, signal)) {
            throw new DOMException('Runtime lifecycle ended.', 'AbortError');
        }
    }
}
```

Use `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts` and its focused
tests as the current evidence for an injected runtime boundary with scoped
subscriptions. The concrete dependency adapter passes the supplied signal to
`rallar.start({ signal, ... })` and `rallar.rooms.enter(room, { signal })`.

## React Adapter

React owns routes, forms, HUD, accessibility, and low-frequency runtime state.
It subscribes to a runtime projection and cleans up the runtime in
`useEffect`; transport setup, room channel callbacks, and cleanup stay in the
runtime.

```tsx
useEffect(() => {
    const runtime = createRallarAppRuntime();
    const unsubscribe = runtime.onState(setRuntimeViewState);
    void runtime.start(initialRoomRef).catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
            showRuntimeError(error);
        }
    });

    return () => {
        unsubscribe();
        runtime.dispose();
    };
}, [initialRoomRef]);
```

Do not mirror per-frame entities or renderer objects into ordinary React state.

## Cancellation And Cleanup

Give each active boot, login, room, or renderer lifecycle one `AbortController`
or monotonic generation. Abort or advance it before logout, room switch,
unmount, hot reload, and renderer replacement. Every async completion must
check its signal/generation before publishing state.

Make teardown safe after partial initialization and safe to call repeatedly.
In reverse ownership order, clear Rallar subscriptions, channel listeners,
timers, workers, media/audio handles, room-bound handles, Motion tracks, and
renderer resources. Ignore stale completions instead of letting an old room or
renderer repopulate current state.

## Capability Expansion

After the first slice works, route expansion deliberately:

| Capability | Specialist skill and smallest evidence |
| --- | --- |
| Match rules and authority | `rallar-games`; Game and server-authority examples |
| Rooms, Messages, Realtime | `rallar-realtime`; room channel examples |
| Motion presentation | `rallar-games`; `examples/motion-smoothing` |
| Browser-local Data | `rallar-platform`; `examples/browser-data-store` |
| Authored CRDT documents | `rallar-platform`; `examples/room-crdt-document` |
| AI proposals | `rallar-ai`; RallarAI examples |
| Media/calls | `rallar-realtime`; focused facade code and tests |
| Server authority/app data | `rallar-platform` and `rallar-games`; server examples |

Use `references/example-map.md` for exact routes. Use an ecosystem renderer,
asset, or playtesting skill only after preserving these Rallar boundaries.

## Minimum Validation

- Pure-domain tests for deterministic rules, validation, ordering, and
  authority decisions.
- Runtime tests with fake injected dependencies for setup/start handoff, room
  binding, subscriptions, cancellation, stale completions, and idempotent
  disposal.
- Focused app build and typecheck using the commands selected by
  `rallar-testing`.
- One visible browser vertical slice covering boot/login, room entry, one send,
  one receive, failure state, and cleanup at the changed viewport sizes.
