import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import {
    readStateEventListQuery,
    type StateEventListQuery
} from '@shared-server/rallar-system/state-events/state-event-listing.ts';
import type { ClientEvent, ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import { authorizationDenied } from '../services/request-auth-service.ts';
import {
    registerClientStateMutationRoutes,
    type ClientStateMutationRouteDependencies
} from './client-state-mutation-routes.ts';
import {
    readCurrentClientSnapshot,
    registerClientStatePointReadRoute,
    type ClientStatePointRead
} from './client-state-point-read-route.ts';
import { readClientStateRouteScope } from './read-client-state-route-scope.ts';
import { toClientStateRouteErrorResponse } from './to-client-state-route-error-response.ts';

export type ClientStateRouteService =
    & Pick<
        ClientStateService,
        | 'listSnapshots'
        | 'readSnapshot'
        | 'readPresenceSnapshot'
        | 'listEvents'
        | 'listRecentEvents'
        | 'listEventPage'
    >
    & Readonly<{
        readCurrentSnapshot?(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
    }>;

export type ClientStateRouteDependencies =
    & ClientStateMutationRouteDependencies
    & Readonly<{
        clientStateService: ClientStateRouteService;
        readClientSnapshot: ClientStatePointRead;
        strictReadAuthorization: boolean;
    }>;

export function registerClientStateRoutes(
    app: Hono,
    dependencies: ClientStateRouteDependencies
): void {
    const deps = dependencies;

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients',
        async (c) => {
            try {
                const scope = readClientStateRouteScope(c);
                const authSession = await readStrictReadAuthSession(c.req, deps);
                const snapshots = authSession
                    ? [
                        await readCurrentClientSnapshot(deps.clientStateService, {
                            ...scope,
                            principalId: authSession.clientId
                        })
                    ].filter(isDefined)
                    : await deps.clientStateService.listSnapshots(scope);
                hydrateClientSnapshots(deps, snapshots);
                return c.json(snapshots);
            }
            catch (error) {
                return toClientStateRouteErrorResponse(
                    c,
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        }
    );

    registerClientStatePointReadRoute(app, {
        read: deps.readClientSnapshot,
        requireAuthSession: deps.requireApiAuthSession,
        strictReadAuthorization: deps.strictReadAuthorization,
        hydrate: (snapshots) => hydrateClientSnapshots(deps, snapshots),
        toErrorResponse: (response, error) =>
            toClientStateRouteErrorResponse(
                response,
                error instanceof Error ? error : new Error(String(error))
            )
    });

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/presence',
        async (c) => {
            try {
                const principalId = c.req.param('principalId');
                await assertCanReadClientState(c.req, deps, principalId);
                const snapshot = await deps.clientStateService.readPresenceSnapshot({
                    ...readClientStateRouteScope(c),
                    principalId
                });

                return snapshot
                    ? c.json(snapshot)
                    : c.json({ error: `Client presence not found: ${principalId}` }, 404);
            }
            catch (error) {
                return toClientStateRouteErrorResponse(
                    c,
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        }
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/events',
        async (c) => {
            try {
                const principalId = c.req.param('principalId');
                await assertCanReadClientState(c.req, deps, principalId);
                const ref = {
                    ...readClientStateRouteScope(c),
                    principalId
                };
                const query = readStateEventListQuery(
                    new URL(c.req.raw.url).searchParams
                );

                return c.json(
                    await listRecentClientEventsForArrayRoute(
                        deps.clientStateService,
                        ref,
                        query
                    )
                );
            }
            catch (error) {
                return toClientStateRouteErrorResponse(
                    c,
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        }
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/events/page',
        async (c) => {
            try {
                const principalId = c.req.param('principalId');
                await assertCanReadClientState(c.req, deps, principalId);

                return c.json(
                    await deps.clientStateService.listEventPage(
                        {
                            ...readClientStateRouteScope(c),
                            principalId
                        },
                        readStateEventListQuery(
                            new URL(c.req.raw.url).searchParams
                        )
                    )
                );
            }
            catch (error) {
                return toClientStateRouteErrorResponse(
                    c,
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        }
    );

    registerClientStateMutationRoutes(app, deps);
}

async function listRecentClientEventsForArrayRoute(
    service: ClientStateRouteService,
    ref: ClientPrincipalRef,
    query: StateEventListQuery
): Promise<readonly ClientEvent[]> {
    return await service.listRecentEvents(ref, query);
}

async function assertCanReadClientState(
    req: {
        header(name: string): string | undefined;
    },
    deps: ClientStateRouteDependencies,
    principalId: string
): Promise<void> {
    const authSession = await readStrictReadAuthSession(req, deps);
    if (!authSession) {
        return;
    }

    if (authSession.clientId !== principalId) {
        throw authorizationDenied(
            'Forbidden: state read principal id does not match authenticated client'
        );
    }
}

async function readStrictReadAuthSession(
    req: {
        header(name: string): string | undefined;
    },
    deps: ClientStateRouteDependencies
): Promise<IssuedAuthSession | undefined> {
    return deps.strictReadAuthorization ? await deps.requireApiAuthSession(req) : undefined;
}

function hydrateClientSnapshots(
    deps: ClientStateRouteDependencies,
    clients: readonly ClientSnapshot[]
): void {
    if (clients.length === 0) {
        return;
    }

    void deps.hydrateStateSyncSnapshotCaches({ clients })
        .catch((error) => console.warn('Failed to hydrate client state sync snapshot caches', error));
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}
