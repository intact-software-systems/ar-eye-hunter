# Rallar Server API V1

`apps/api-v1` is the generic Rallar Server shell. It owns auth, rooms, presence/lifecycle, dynamic
WS topics, RTC signaling/topology, CRDT, app data, and route mounting. It should not become a
concrete game server.

## Rallar Game

Browser-director games use the normal Rallar browser facade. `api-v1` already provides the needed
server primitives for rooms, director state, WS, RTC, and relay support; no Rallar Game topics are
installed by default.

Server-authoritative games opt in with Rallar Game Authority through the existing `.ws` facade. The
game owns simulation, command legality, payload validation, persistence, scoring, AI, and rendering.

Use room-scoped topic IDs such as `room.cash-chase.authority`. The dynamic WS router intentionally
supports user topics under `app.*` and `room.*`; `game.*` is not a supported namespace.

```ts
import { installRallarGameAuthorityServer } from '@shared-server/game/mod.ts';
import { createRallarServer } from './src/create-rallar-server.ts';

const rallar = createRallarServer();

installRallarGameAuthorityServer<
  CashChaseCommand,
  CashChaseSnapshot,
  CashChaseEvent
>({
  rallar,
  protocol: 'cash-chase.authority.v1',
  topicId: 'room.cash-chase.authority',
  handleCommand: cashChaseService.handleCommand,
  readSnapshot: cashChaseService.readSnapshot,
});

rallar.system.useDefaultMiddlewareTopics().useWebSocketLifecycle();
rallar.ws.mount(app);
rallar.rest.mount(app);
rallar.start();
```
