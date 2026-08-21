import type { AuthSession } from '@shared/api/api-config.ts';
import type { ApiMutationFailureJsonValue } from '@shared/api/mutation/api-mutation-failure.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';

import { decodeJsonWireValue } from '@shared-server/rallar-system/services/\
mutation-command-identity.ts';
import {
    requireApiAdminSession as defaultRequireApiAdminSession,
    type ApiAdminAuthDependencies
} from '../services/admin-auth-service.ts';
import { toApiMutationFailureResponse } from './api-mutation-route-failure.ts';
import { readApiMutationRouteRequestId } from './api-mutation-route-ingress.ts';

export type AdminOperationReadInput = Readonly<{
    adminSession: AuthSession;
    scope?: StateScope;
}>;

export type AdminOperationWriteInput<TRequest> = Readonly<{
    adminSession: AuthSession;
    request: TRequest;
}>;

export interface AdminOperationMutationWriteInput<TRequest> {
    readonly adminSession: AuthSession;
    readonly requestId: string;
    readonly request: TRequest;
}

export type AdminOperationsServiceLike = Readonly<{
    readOverview(input: AdminOperationReadInput): Promise<unknown>;
    readQueues(input: AdminOperationReadInput): Promise<unknown>;
    readRealtime(input: AdminOperationReadInput): Promise<unknown>;
    readState(input: AdminOperationReadInput): Promise<unknown>;
    readCrdt(input: AdminOperationReadInput): Promise<unknown>;
    readSystem(input: AdminOperationReadInput): Promise<unknown>;
    resetMetrics(input: AdminOperationWriteInput<unknown>): Promise<unknown>;
    recomputeTopology(
        input: AdminOperationMutationWriteInput<ApiMutationFailureJsonValue>
    ): Promise<unknown>;
    pruneExpired(
        input: AdminOperationMutationWriteInput<ApiMutationFailureJsonValue>
    ): Promise<unknown>;
    verifyCrdtIntegrity(input: AdminOperationWriteInput<unknown>): Promise<unknown>;
    exportCrdtDebug(input: AdminOperationWriteInput<unknown>): Promise<unknown>;
    compactCrdt(
        input: AdminOperationMutationWriteInput<ApiMutationFailureJsonValue>
    ): Promise<unknown>;
    updateCrdtLifecycle(
        input: AdminOperationMutationWriteInput<ApiMutationFailureJsonValue>
    ): Promise<unknown>;
    eraseCrdt(
        input: AdminOperationMutationWriteInput<ApiMutationFailureJsonValue>
    ): Promise<unknown>;
}>;

export type AdminOperationsRouteDependencies = Readonly<
    ApiAdminAuthDependencies & {
        operations: AdminOperationsServiceLike;
        requireApiAdminSession?: (
            req: { header(name: string): string | undefined; },
            dependencies: ApiAdminAuthDependencies
        ) => Promise<AuthSession>;
        now: () => number;
    }
>;

export function init(
    app: Hono,
    dependencies: AdminOperationsRouteDependencies
): void {
    const deps = dependencies;

    app.get(
        '/api/admin/operations/overview',
        (c) => withAdmin(c, deps, (adminSession) => deps.operations.readOverview({ adminSession }))
    );

    app.get(
        '/api/admin/operations/queues',
        (c) => withAdmin(c, deps, (adminSession) => deps.operations.readQueues({ adminSession }))
    );

    app.get(
        '/api/admin/operations/realtime',
        (c) => withAdmin(c, deps, (adminSession) => deps.operations.readRealtime({ adminSession }))
    );

    app.get(
        '/api/admin/operations/state',
        (c) => withAdmin(c, deps, (adminSession) => deps.operations.readState({ adminSession }))
    );

    app.get(
        '/api/admin/operations/state/apps/:applicationId/workspaces/:workspaceId',
        (c) =>
            withAdmin(c, deps, (adminSession) =>
                deps.operations.readState({
                    adminSession,
                    scope: toScope(c)
                }))
    );

    app.get(
        '/api/admin/operations/crdt',
        (c) => withAdmin(c, deps, (adminSession) => deps.operations.readCrdt({ adminSession }))
    );

    app.get(
        '/api/admin/operations/crdt/apps/:applicationId/workspaces/:workspaceId',
        (c) =>
            withAdmin(c, deps, (adminSession) =>
                deps.operations.readCrdt({
                    adminSession,
                    scope: toScope(c)
                }))
    );

    app.get(
        '/api/admin/operations/system',
        (c) => withAdmin(c, deps, (adminSession) => deps.operations.readSystem({ adminSession }))
    );

    app.post(
        '/api/admin/operations/metrics/reset',
        (c) =>
            withAdminJson(
                c,
                deps,
                (adminSession, request) => deps.operations.resetMetrics({ adminSession, request })
            )
    );

    app.post(
        '/api/admin/operations/topology/recompute/requests/:requestId',
        (c) =>
            withAdminMutationJson(
                c,
                deps,
                (adminSession, requestId, request) =>
                    deps.operations.recomputeTopology({ adminSession, requestId, request })
            )
    );

    app.post(
        '/api/admin/operations/maintenance/prune-expired/requests/:requestId',
        (c) =>
            withAdminMutationJson(
                c,
                deps,
                (adminSession, requestId, request) => deps.operations.pruneExpired({ adminSession, requestId, request })
            )
    );

    app.post(
        '/api/admin/operations/crdt/integrity',
        (c) =>
            withAdminJson(
                c,
                deps,
                (adminSession, request) => deps.operations.verifyCrdtIntegrity({ adminSession, request })
            )
    );

    app.post(
        '/api/admin/operations/crdt/debug-export',
        (c) =>
            withAdminJson(
                c,
                deps,
                (adminSession, request) => deps.operations.exportCrdtDebug({ adminSession, request })
            )
    );

    app.post(
        '/api/admin/operations/crdt/compact/requests/:requestId',
        (c) =>
            withAdminMutationJson(
                c,
                deps,
                (adminSession, requestId, request) => deps.operations.compactCrdt({ adminSession, requestId, request })
            )
    );

    app.post(
        '/api/admin/operations/crdt/lifecycle/requests/:requestId',
        (c) =>
            withAdminMutationJson(
                c,
                deps,
                (adminSession, requestId, request) =>
                    deps.operations.updateCrdtLifecycle({ adminSession, requestId, request })
            )
    );

    app.post(
        '/api/admin/operations/crdt/erase/requests/:requestId',
        (c) =>
            withAdminMutationJson(
                c,
                deps,
                (adminSession, requestId, request) => deps.operations.eraseCrdt({ adminSession, requestId, request })
            )
    );
}

async function withAdmin(
    c: Context,
    deps: AdminOperationsRouteDependencies,
    execute: (session: AuthSession) => Promise<unknown>
): Promise<Response> {
    try {
        const adminSession = await requireAdminSession(c, deps);
        return c.json(await execute(adminSession));
    }
    catch (error) {
        return toErrorResponse(c, error);
    }
}

async function withAdminJson(
    c: Context,
    deps: AdminOperationsRouteDependencies,
    execute: (session: AuthSession, request: ApiMutationFailureJsonValue) => Promise<unknown>
): Promise<Response> {
    return await withAdmin(
        c,
        deps,
        async (adminSession) => await execute(adminSession, await readOptionalJsonBody(c))
    );
}

async function withAdminMutationJson<TResult>(
    context: Context,
    dependencies: AdminOperationsRouteDependencies,
    execute: (
        session: AuthSession,
        requestId: string,
        request: ApiMutationFailureJsonValue
    ) => Promise<TResult>
): Promise<Response> {
    try {
        const adminSession = await requireAdminSession(context, dependencies);
        const request = await readOptionalJsonBody(context);
        const requestId = readApiMutationRouteRequestId({
            requestId: context.req.param('requestId'),
            idempotencyKey: context.req.header('idempotency-key'),
            mutationBody: request
        });
        return context.json(await execute(adminSession, requestId, request));
    }
    catch (error) {
        return toApiMutationFailureResponse(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

async function requireAdminSession(
    c: Context,
    deps: AdminOperationsRouteDependencies
): Promise<AuthSession> {
    return await (deps.requireApiAdminSession ?? defaultRequireApiAdminSession)(
        c.req,
        {
            adminClientIds: deps.adminClientIds,
            requireApiAuthSession: deps.requireApiAuthSession
        }
    );
}

async function readOptionalJsonBody(c: Context): Promise<ApiMutationFailureJsonValue> {
    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
        return {};
    }

    try {
        return decodeJsonWireValue(await c.req.json(), 'Admin operation request');
    }
    catch {
        const error = new Error('Malformed JSON request body') as Error & { status: number; };
        error.status = 400;
        throw error;
    }
}

function toScope(c: Context): StateScope {
    return {
        applicationId: c.req.param('applicationId'),
        workspaceId: c.req.param('workspaceId')
    };
}

function toErrorResponse(
    c: { json(value: unknown, status?: number): Response; },
    error: unknown
): Response {
    const message = error instanceof Error ? error.message : String(error);
    const status = isStatusError(error)
        ? error.status
        : message.includes('not found')
        ? 404
        : message.startsWith('Unauthorized:')
        ? 401
        : message.startsWith('Forbidden:')
        ? 403
        : message.includes('stale') || message.includes('conflict')
        ? 409
        : 400;

    return c.json({ error: message }, status);
}

function isStatusError(error: unknown): error is Error & { status: number; } {
    return error instanceof Error &&
        typeof (error as { status?: unknown; }).status === 'number';
}
