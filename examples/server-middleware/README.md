# Server Middleware

Most server apps should compose `createRallarMiddleware(...)` through
`createRallarServerApplication(...)`. The middleware owns WS queuebox routing,
app-inbox services, state-sync publication, repositories, and lifecycle topics.

```ts
import { createRallarServerApplication } from '@shared-server/rallar-facade/RallarServerApplication.ts';
import { createRallarMiddleware } from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import { AppGroupInboxService } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { createWsStateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';

const runtime = createRallarMiddleware({
    inbox: queueBoxRepository,
    outbox: queueBoxRepository,
    webSocketServer,
    wsRuntimeName: 'api-v1',
    clientsRepository,
    groupsRepository,
    findGroupSnapshotByRef: (ref) => groupSnapshotCache.findByRef(ref),
    createAppGroupInboxService: ({ inboxQueueReader, wsQBoxServerService }) =>
        new AppGroupInboxService(
            inboxQueueReader,
            resourceInboxRepository,
            resourceInboxResultsRepository,
            groupStateService,
            createWsStateSyncPublisher(wsQBoxServerService, { serverId }),
            serverId,
        ),
    createAppClientInboxService: ({ inboxQueueReader, wsQBoxServerService }) =>
        new AppClientInboxService(
            inboxQueueReader,
            resourceInboxRepository,
            resourceInboxResultsRepository,
            clientStateService,
            createWsStateSyncPublisher(wsQBoxServerService, { serverId }),
            serverId,
        ),
    resilience: {
        inbox: appInboxResilience,
        outbox: wsOutboxResilience,
    },
});

const rallarServer = createRallarServerApplication({
    runtime,
    routes: {
        ws: installWsRoutes,
        rest: [installAuthRoutes, installStateRoutes],
    },
});

rallarServer.system.useDefaultMiddlewareTopics().useWebSocketLifecycle();
rallarServer.ws.mount(app);
rallarServer.rest.mount(app);
rallarServer.start();
```

Keep app-owned durable mutations behind app-inbox services so a transient WS
publish/enqueue failure does not become a lost state mutation.
