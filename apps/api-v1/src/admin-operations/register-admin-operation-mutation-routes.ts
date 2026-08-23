import type { AdminPruneEnqueueResult } from '@shared-server/rallar-system/admin-operations/inbox/app-admin-inbox-service.ts';
import type {
    CrdtAdminCompactResult,
    CrdtAdminEraseResult
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import type { TopologyReconfigureInboxResult } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import {
    ADMIN_PRUNE_EXPIRED_CATEGORIES,
    type AdminPruneExpiredCategory,
    type AdminPruneExpiredRequest,
    type AdminTopologyRecomputeRequest
} from '@shared/api/admin-operations-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    fromCanonicalGroupTopologyConfigPatch,
    toCanonicalGroupTopologyConfigPatch
} from '@shared/api/group-topology-config-canonical.ts';
import { assertValidRallarGroupRef } from '@shared/api/rallar-validation.ts';
import type { RallarCrdtDocumentMetadata } from '@shared/crdt/mod.ts';
import { type Context, type Hono } from 'jsr:@hono/hono@4.11.9';

import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { toApiMutationFailureResponse } from '../routes/api-mutation-route-failure.ts';
import { readApiMutationRouteRequestId } from '../routes/api-mutation-route-ingress.ts';
import {
    requireApiAdminSession as defaultRequireApiAdminSession,
    type ApiAdminAuthDependencies
} from '../services/admin-auth-service.ts';

export interface AdminOperationMutationWriteInput<TRequest = JsonWireValue> {
    readonly adminSession: AuthSession;
    readonly requestId: string;
    readonly request: TRequest;
}

export interface AdminOperationMutationRouteService {
    readonly recomputeTopology: (
        input: AdminOperationMutationWriteInput<AdminTopologyRecomputeRequest>
    ) => Promise<TopologyReconfigureInboxResult>;
    readonly pruneExpired: (
        input: AdminOperationMutationWriteInput<AdminPruneExpiredRequest>
    ) => Promise<AdminPruneEnqueueResult>;
    readonly compactCrdt: (
        input: AdminOperationMutationWriteInput
    ) => Promise<CrdtAdminCompactResult>;
    readonly updateCrdtLifecycle: (
        input: AdminOperationMutationWriteInput
    ) => Promise<RallarCrdtDocumentMetadata>;
    readonly eraseCrdt: (
        input: AdminOperationMutationWriteInput
    ) => Promise<CrdtAdminEraseResult>;
}

export type AdminOperationMutationRouteDependencies = Readonly<
    ApiAdminAuthDependencies & {
        operations: AdminOperationMutationRouteService;
        requireApiAdminSession?: (
            request: { header(name: string): string | undefined; },
            dependencies: ApiAdminAuthDependencies
        ) => Promise<AuthSession>;
    }
>;

export function registerAdminOperationMutationRoutes(
    app: Hono,
    dependencies: AdminOperationMutationRouteDependencies
): void {
    app.post(
        '/api/admin/operations/topology/recompute/requests/:requestId',
        (context) =>
            withAdminMutationJson(
                context,
                dependencies,
                (input) =>
                    dependencies.operations.recomputeTopology({
                        ...input,
                        request: readTopologyRecomputeRequest(input.request)
                    })
            )
    );
    app.post(
        '/api/admin/operations/maintenance/prune-expired/requests/:requestId',
        (context) =>
            withAdminMutationJson(
                context,
                dependencies,
                (input) =>
                    dependencies.operations.pruneExpired({
                        ...input,
                        request: readAdminPruneExpiredRequest(input.request)
                    })
            )
    );
    app.post(
        '/api/admin/operations/crdt/compact/requests/:requestId',
        (context) =>
            withAdminMutationJson(
                context,
                dependencies,
                (input) => dependencies.operations.compactCrdt(input)
            )
    );
    app.post(
        '/api/admin/operations/crdt/lifecycle/requests/:requestId',
        (context) =>
            withAdminMutationJson(
                context,
                dependencies,
                (input) => dependencies.operations.updateCrdtLifecycle(input)
            )
    );
    app.post(
        '/api/admin/operations/crdt/erase/requests/:requestId',
        (context) =>
            withAdminMutationJson(
                context,
                dependencies,
                (input) => dependencies.operations.eraseCrdt(input)
            )
    );
}

async function withAdminMutationJson<TResult>(
    context: Context,
    dependencies: AdminOperationMutationRouteDependencies,
    execute: (input: AdminOperationMutationWriteInput) => Promise<TResult>
): Promise<Response> {
    try {
        const adminSession = await requireAdminSession(context, dependencies);
        const request = await readOptionalJsonBody(context);
        const requestId = readApiMutationRouteRequestId({
            requestId: context.req.param('requestId'),
            idempotencyKey: context.req.header('idempotency-key'),
            mutationBody: request
        });
        return context.json(await execute({ adminSession, requestId, request }));
    }
    catch (error) {
        return toApiMutationFailureResponse(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

async function requireAdminSession(
    context: Context,
    dependencies: AdminOperationMutationRouteDependencies
): Promise<AuthSession> {
    return await (dependencies.requireApiAdminSession ?? defaultRequireApiAdminSession)(
        context.req,
        {
            adminClientIds: dependencies.adminClientIds,
            requireApiAuthSession: dependencies.requireApiAuthSession
        }
    );
}

async function readOptionalJsonBody(
    context: Context
): Promise<JsonWireValue> {
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

function readTopologyRecomputeRequest(value: JsonWireValue): AdminTopologyRecomputeRequest {
    const request = readJsonObject(value, 'Admin topology recompute request');
    const publish = request.publish;
    if (publish !== undefined && typeof publish !== 'boolean') {
        throw new TypeError('Admin topology recompute publish must be a boolean');
    }
    const reason = request.reason;
    if (reason !== undefined && typeof reason !== 'string') {
        throw new TypeError('Admin topology recompute reason must be a string');
    }
    return {
        groupRef: assertValidRallarGroupRef(request.groupRef, '$.groupRef'),
        ...(publish === undefined ? {} : { publish }),
        ...(request.options === undefined
            ? {}
            : {
                options: fromCanonicalGroupTopologyConfigPatch(
                    toCanonicalGroupTopologyConfigPatch(request.options)
                )
            }),
        ...(reason === undefined ? {} : { reason })
    };
}

function readAdminPruneExpiredRequest(value: JsonWireValue): AdminPruneExpiredRequest {
    const request = readJsonObject(value, 'Admin prune request');
    const dryRun = request.dryRun;
    if (dryRun !== undefined && typeof dryRun !== 'boolean') {
        throw new TypeError('Admin prune dryRun must be a boolean');
    }
    const reason = request.reason;
    if (reason !== undefined && typeof reason !== 'string') {
        throw new TypeError('Admin prune reason must be a string');
    }
    return {
        ...(request.categories === undefined
            ? {}
            : { categories: readAdminPruneCategories(request.categories) }),
        ...(request.appData === undefined
            ? {}
            : { appData: readAdminPruneAppData(request.appData) }),
        ...(dryRun === undefined ? {} : { dryRun }),
        ...(reason === undefined ? {} : { reason })
    };
}

function readAdminPruneCategories(value: JsonWireValue): readonly AdminPruneExpiredCategory[] {
    if (!Array.isArray(value)) {
        throw new TypeError('Admin prune categories must be an array');
    }
    return value.map((category) => {
        if (!isAdminPruneExpiredCategory(category)) {
            throw new TypeError('Admin prune category is invalid');
        }
        return category;
    });
}

function readAdminPruneAppData(
    value: JsonWireValue
): NonNullable<AdminPruneExpiredRequest['appData']> {
    const appData = readJsonObject(value, 'Admin prune appData');
    const namespace = appData.namespace;
    const storeName = appData.storeName;
    if (namespace !== undefined && typeof namespace !== 'string') {
        throw new TypeError('Admin prune appData namespace must be a string');
    }
    if (storeName !== undefined && typeof storeName !== 'string') {
        throw new TypeError('Admin prune appData storeName must be a string');
    }
    return {
        ...(namespace === undefined ? {} : { namespace }),
        ...(storeName === undefined ? {} : { storeName })
    };
}

function readJsonObject(value: JsonWireValue, label: string): JsonWireObject {
    if (!isJsonObject(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function isJsonObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAdminPruneExpiredCategory(
    value: JsonWireValue
): value is AdminPruneExpiredCategory {
    return ADMIN_PRUNE_EXPIRED_CATEGORIES.some((category) => category === value);
}
