import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type {
    AdminMetricsResetCategory,
    AdminMetricsResetRequest,
    AdminOperationResultResponse,
    AdminOperationsCrdtResponse,
    AdminOperationsOverviewResponse,
    AdminOperationsQueuesResponse,
    AdminOperationsRealtimeResponse,
    AdminOperationsStateResponse,
    AdminOperationsSystemResponse
} from '@shared/api/admin-operations-types.ts';
import { ADMIN_METRICS_RESET_CATEGORIES } from '@shared/api/admin-operations-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { RallarCrdtDebugBundle, RallarCrdtIntegrityReport } from '@shared/crdt/mod.ts';
import { type Context, type Hono } from 'jsr:@hono/hono@4.11.9';

import {
    requireApiAdminSession as defaultRequireApiAdminSession,
    type ApiAdminAuthDependencies
} from '../services/admin-auth-service.ts';

export interface AdminOperationReadInput {
    readonly adminSession: AuthSession;
    readonly scope?: StateScope;
}

export interface AdminOperationWriteInput<TRequest> {
    readonly adminSession: AuthSession;
    readonly request: TRequest;
}

export interface AdminOperationReadRouteService {
    readonly readOverview: (
        input: AdminOperationReadInput
    ) => Promise<AdminOperationsOverviewResponse>;
    readonly readQueues: (
        input: AdminOperationReadInput
    ) => Promise<AdminOperationsQueuesResponse>;
    readonly readRealtime: (
        input: AdminOperationReadInput
    ) => Promise<AdminOperationsRealtimeResponse>;
    readonly readState: (
        input: AdminOperationReadInput
    ) => Promise<AdminOperationsStateResponse>;
    readonly readCrdt: (
        input: AdminOperationReadInput
    ) => Promise<AdminOperationsCrdtResponse>;
    readonly readSystem: (
        input: AdminOperationReadInput
    ) => Promise<AdminOperationsSystemResponse>;
    readonly resetMetrics: (
        input: AdminOperationWriteInput<AdminMetricsResetRequest>
    ) => Promise<AdminOperationResultResponse>;
    readonly verifyCrdtIntegrity: (
        input: AdminOperationWriteInput<JsonWireValue>
    ) => Promise<RallarCrdtIntegrityReport>;
    readonly exportCrdtDebug: (
        input: AdminOperationWriteInput<JsonWireValue>
    ) => Promise<RallarCrdtDebugBundle>;
}

export type AdminOperationReadRouteDependencies = Readonly<
    ApiAdminAuthDependencies & {
        operations: AdminOperationReadRouteService;
        requireApiAdminSession?: (
            request: { header(name: string): string | undefined; },
            dependencies: ApiAdminAuthDependencies
        ) => Promise<AuthSession>;
    }
>;

export function registerAdminOperationReadRoutes(
    app: Hono,
    dependencies: AdminOperationReadRouteDependencies
): void {
    app.get(
        '/api/admin/operations/overview',
        (context) =>
            withAdminRead(
                context,
                dependencies,
                (adminSession) => dependencies.operations.readOverview({ adminSession })
            )
    );
    app.get(
        '/api/admin/operations/queues',
        (context) =>
            withAdminRead(context, dependencies, (adminSession) => dependencies.operations.readQueues({ adminSession }))
    );
    app.get(
        '/api/admin/operations/realtime',
        (context) =>
            withAdminRead(
                context,
                dependencies,
                (adminSession) => dependencies.operations.readRealtime({ adminSession })
            )
    );
    app.get(
        '/api/admin/operations/state',
        (context) =>
            withAdminRead(context, dependencies, (adminSession) => dependencies.operations.readState({ adminSession }))
    );
    app.get(
        '/api/admin/operations/state/apps/:applicationId/workspaces/:workspaceId',
        (context) =>
            withAdminRead(context, dependencies, (adminSession) =>
                dependencies.operations.readState({
                    adminSession,
                    scope: readStateScope(context)
                }))
    );
    app.get(
        '/api/admin/operations/crdt',
        (context) =>
            withAdminRead(context, dependencies, (adminSession) => dependencies.operations.readCrdt({ adminSession }))
    );
    app.get(
        '/api/admin/operations/crdt/apps/:applicationId/workspaces/:workspaceId',
        (context) =>
            withAdminRead(context, dependencies, (adminSession) =>
                dependencies.operations.readCrdt({
                    adminSession,
                    scope: readStateScope(context)
                }))
    );
    app.get(
        '/api/admin/operations/system',
        (context) =>
            withAdminRead(context, dependencies, (adminSession) => dependencies.operations.readSystem({ adminSession }))
    );
    app.post(
        '/api/admin/operations/metrics/reset',
        (context) =>
            withAdminReadJson(context, dependencies, (adminSession, request) =>
                dependencies.operations.resetMetrics({
                    adminSession,
                    request: readMetricsResetRequest(request)
                }))
    );
    app.post(
        '/api/admin/operations/crdt/integrity',
        (context) =>
            withAdminReadJson(
                context,
                dependencies,
                (adminSession, request) => dependencies.operations.verifyCrdtIntegrity({ adminSession, request })
            )
    );
    app.post(
        '/api/admin/operations/crdt/debug-export',
        (context) =>
            withAdminReadJson(
                context,
                dependencies,
                (adminSession, request) => dependencies.operations.exportCrdtDebug({ adminSession, request })
            )
    );
}

async function withAdminRead<TResult>(
    context: Context,
    dependencies: AdminOperationReadRouteDependencies,
    execute: (session: AuthSession) => Promise<TResult>
): Promise<Response> {
    try {
        const adminSession = await requireAdminSession(context, dependencies);
        return context.json(await execute(adminSession));
    }
    catch (error) {
        return toAdminReadErrorResponse(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

async function withAdminReadJson<TResult>(
    context: Context,
    dependencies: AdminOperationReadRouteDependencies,
    execute: (session: AuthSession, request: JsonWireValue) => Promise<TResult>
): Promise<Response> {
    return await withAdminRead(
        context,
        dependencies,
        async (adminSession) => await execute(adminSession, await readOptionalJsonBody(context))
    );
}

async function requireAdminSession(
    context: Context,
    dependencies: AdminOperationReadRouteDependencies
): Promise<AuthSession> {
    return await (dependencies.requireApiAdminSession ?? defaultRequireApiAdminSession)(
        context.req,
        {
            adminClientIds: dependencies.adminClientIds,
            requireApiAuthSession: dependencies.requireApiAuthSession
        }
    );
}

async function readOptionalJsonBody(context: Context): Promise<JsonWireValue> {
    const contentType = context.req.header('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
        return {};
    }
    try {
        return decodeJsonWireValue(await context.req.json(), 'Admin operation request');
    }
    catch {
        const error = new Error('Malformed JSON request body') as Error & { status: number; };
        error.status = 400;
        throw error;
    }
}

function readStateScope(context: Context): StateScope {
    return {
        applicationId: context.req.param('applicationId'),
        workspaceId: context.req.param('workspaceId')
    };
}

function toAdminReadErrorResponse(
    context: { json(value: JsonWireValue, status?: number): Response; },
    error: Error
): Response {
    const message = error.message;
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
    return context.json({ error: message }, status);
}

interface AdminReadStatusError extends Error {
    readonly status: number;
}

function isStatusError(error: Error): error is AdminReadStatusError {
    return 'status' in error && typeof error.status === 'number';
}

function readMetricsResetRequest(value: JsonWireValue): AdminMetricsResetRequest {
    if (!isJsonObject(value)) {
        throw new TypeError('Admin metrics reset request must be an object');
    }
    return {
        ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
        ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
        ...(value.categories === undefined
            ? {}
            : { categories: readMetricsResetCategories(value.categories) })
    };
}

function readMetricsResetCategories(value: JsonWireValue): readonly AdminMetricsResetCategory[] {
    if (!Array.isArray(value)) {
        throw new TypeError('Admin metrics reset categories must be an array');
    }
    return value.map((category) => {
        if (
            !isAdminMetricsResetCategory(category)
        ) {
            throw new TypeError(`Unsupported admin metrics reset category: ${String(category)}`);
        }
        return category;
    });
}

function isJsonObject(value: JsonWireValue): value is Readonly<Record<string, JsonWireValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAdminMetricsResetCategory(value: JsonWireValue): value is AdminMetricsResetCategory {
    return ADMIN_METRICS_RESET_CATEGORIES.some((category) => category === value);
}
