import { Hono } from 'jsr:@hono/hono@4.11.9';

import { type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    AuditStamp,
    ClientEvent,
    ClientSnapshot
} from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { GroupStateRouteAuthSession } from '../../src/group-state/group-state-route-contracts.ts';
import type { ProcessClientAppInbox } from '../../src/routes/client-state-mutation-routes.ts';
import * as clientStateRoutes from '../../src/routes/client-state-routes.ts';

export const TEST_SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};

interface CreateClientRouteDepsInput {
    readonly session: AuthSession & GroupStateRouteAuthSession;
    readonly clientService: Partial<clientStateRoutes.ClientStateRouteService>;
    readonly hydrateStateSyncSnapshotCaches?: clientStateRoutes.ClientStateRouteDependencies[
        'hydrateStateSyncSnapshotCaches'
    ];
    readonly processClientAppInbox?: (
        enqueue: AppInboxEnqueueInput,
        authority: Parameters<ProcessClientAppInbox>[1]
    ) => Promise<Either<AppInboxFailure, ClientStateWritten> | ClientStateWritten>;
    readonly readClientSnapshot?: clientStateRoutes.ClientStateRouteDependencies['readClientSnapshot'];
    readonly strictReadAuthorization?: boolean;
}

interface ClientRouteDeps extends Required<clientStateRoutes.ClientStateRouteDependencies> {
    authCallCount(): number;
}

export function createClientRouteApp(
    deps: ClientRouteDeps
): Hono {
    const app = new Hono();
    installClientStateRouteAuthMiddleware(app, deps.requireApiAuthSession);
    clientStateRoutes.registerClientStateRoutes(app, deps);
    return app;
}

export function installClientStateRouteAuthMiddleware(
    app: Hono,
    requireApiAuthSession: (
        req: { header(name: string): string | undefined; }
    ) => Promise<Pick<AuthSession, 'clientId' | 'sessionId'>>
): void {
    app.use('/api/state/*', async (c, next) => {
        await requireApiAuthSession(c.req);
        await next();
    });
}

export function createClientRouteDeps(
    input: CreateClientRouteDepsInput
): ClientRouteDeps {
    let authCalls = 0;
    const clientStateService: clientStateRoutes.ClientStateRouteService = {
        listSnapshots: () => Promise.resolve([]),
        readSnapshot: () => Promise.resolve(undefined),
        readPresenceSnapshot: () => Promise.resolve(undefined),
        listEvents: () => Promise.resolve([]),
        listRecentEvents: () => Promise.resolve([]),
        listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
        ...input.clientService
    };
    const processClientAppInbox = input.processClientAppInbox;
    return {
        clientStateService,
        requireApiAuthSession: () => {
            authCalls += 1;
            return Promise.resolve(input.session);
        },
        processClientAppInbox: processClientAppInbox
            ? async (enqueue, authority) => {
                const result = await processClientAppInbox(enqueue, authority);
                return result instanceof Either ? result : Either.ofRight(result);
            }
            : () => Promise.reject(new Error('Unexpected client mutation route call')),
        hydrateStateSyncSnapshotCaches: input.hydrateStateSyncSnapshotCaches ??
            (() => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 0 })),
        readClientSnapshot: input.readClientSnapshot ?? (async (ref) => {
            const snapshot = await clientStateService.readSnapshot(ref);
            return snapshot
                ? { status: 'found', source: 'durable', snapshot }
                : { status: 'not-found', source: 'durable' };
        }),
        strictReadAuthorization: input.strictReadAuthorization ?? false,
        authCallCount: () => authCalls
    };
}

export function toClientStateWritten(snapshot: ClientSnapshot): ClientStateWritten {
    return {
        status: 'ok',
        result: { snapshot, event: null }
    };
}

export function createAuthSession(
    clientId: string
): AuthSession & GroupStateRouteAuthSession {
    return {
        clientId,
        accessToken: 'token',
        username: clientId,
        sessionId: `${clientId}-session`,
        issuedAtEpochMs: Date.now() - 1_000,
        expiresAtEpochMs: Date.now() + 60_000
    };
}

export function createClientSnapshot(principalId: string): ClientSnapshot {
    return {
        stateRevision: 1,
        principal: {
            ...TEST_SCOPE,
            principalId,
            username: principalId,
            displayName: principalId,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion: 1,
            profileVersion: 1,
            presenceVersion: 0,
            created: testAuditStamp(1),
            updated: testAuditStamp(1),
            disabled: null,
            deleted: null,
            lastSeenAtEpochMs: null
        },
        instances: [],
        activeSessions: [],
        isOnline: false,
        activeSessionCount: 0,
        lastSeenAtEpochMs: null
    };
}

export function createClientEvent(eventId: string): ClientEvent {
    return {
        ...TEST_SCOPE,
        principalId: 'alice',
        eventId,
        eventType: 'principal-updated',
        snapshotVersion: 1,
        occurredAtEpochMs: 1,
        clientInstanceId: null,
        sessionId: null,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

function testAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
