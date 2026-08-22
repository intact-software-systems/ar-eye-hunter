import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';

import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type { ClientStateSnapshotReadOptions, StateSnapshotReadResult } from '@shared/api/state-snapshot-read.ts';

import {
    readClientSnapshotPointQuery,
    StateSnapshotReadQueryError
} from './state-snapshot-read/state-snapshot-read-query.ts';
import { writeClientSnapshotHeaders } from './state-snapshot-read/state-snapshot-read-response.ts';

export type ClientStatePointRead = (
    ref: ClientPrincipalRef,
    options: ClientStateSnapshotReadOptions & Readonly<{ strictMode?: boolean; }>
) => Promise<StateSnapshotReadResult<ClientSnapshot>>;

interface ClientStatePointRouteDependencies {
    readonly read: ClientStatePointRead;
    readonly requireAuthSession: (
        request: { header(name: string): string | undefined; }
    ) => Promise<Readonly<{ clientId: string; }>>;
    readonly strictReadAuthorization: boolean;
    readonly hydrate: (snapshots: readonly ClientSnapshot[]) => void;
    readonly toErrorResponse: (context: Context, error: Error) => Response;
}

export function registerClientStatePointReadRoute(
    app: Hono,
    dependencies: ClientStatePointRouteDependencies
): void {
    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId',
        (context) => readClientStatePoint(context, dependencies)
    );
}

async function readClientStatePoint(
    context: Context,
    dependencies: ClientStatePointRouteDependencies
): Promise<Response> {
    try {
        const principalId = context.req.param('principalId');
        const strictMode = await assertSelfWhenStrict(context, dependencies, principalId);
        const result = await dependencies.read({
            applicationId: context.req.param('applicationId'),
            workspaceId: context.req.param('workspaceId'),
            principalId
        }, {
            ...readClientSnapshotPointQuery(new URL(context.req.raw.url).searchParams),
            strictMode
        });
        return toClientStatePointResponse({ context, dependencies, principalId, result });
    }
    catch (error) {
        if (error instanceof StateSnapshotReadQueryError) {
            return context.json({ error: error.message, code: error.code }, 400);
        }
        const routeError = error instanceof Error ? error : new Error(String(error));
        return dependencies.toErrorResponse(context, routeError);
    }
}

function toClientStatePointResponse(
    input: Readonly<{
        context: Context;
        dependencies: ClientStatePointRouteDependencies;
        principalId: string;
        result: StateSnapshotReadResult<ClientSnapshot>;
    }>
): Response {
    const { context, dependencies, principalId, result } = input;
    if (result.status === 'not-found') {
        return context.json({ error: `Client not found: ${principalId}` }, 404);
    }
    if (result.status === 'floor-not-satisfied') {
        return context.json({
            error: 'Client state revision floor was not satisfied',
            code: 'state-revision-floor-not-satisfied'
        }, 409);
    }
    dependencies.hydrate([result.snapshot]);
    writeClientSnapshotHeaders(context, result.source, result.snapshot);
    return context.json(result.snapshot);
}

export function createDurableClientStatePointRead(
    getService: () => Readonly<{
        readSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
    }>
): ClientStatePointRead {
    return async (ref) => {
        const snapshot = await getService().readSnapshot(ref);
        return snapshot
            ? { status: 'found', source: 'durable', snapshot }
            : { status: 'not-found', source: 'durable' };
    };
}

export function readCurrentClientSnapshot(
    service: Readonly<{
        readSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
        readCurrentSnapshot?(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
    }>,
    ref: ClientPrincipalRef
): Promise<ClientSnapshot | undefined> {
    return service.readCurrentSnapshot?.(ref) ?? service.readSnapshot(ref);
}

async function assertSelfWhenStrict(
    context: Context,
    dependencies: Pick<ClientStatePointRouteDependencies, 'requireAuthSession' | 'strictReadAuthorization'>,
    principalId: string
): Promise<boolean> {
    if (!dependencies.strictReadAuthorization) {
        return false;
    }
    const authSession = await dependencies.requireAuthSession(context.req);
    if (authSession.clientId !== principalId) {
        throw new Error(
            'Forbidden: state read principal id does not match authenticated client'
        );
    }
    return true;
}
