import type { Context, Hono } from 'jsr:@hono/hono@4.11.9';

import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { decodeJsonWireValue, type JsonWireObject } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    RALLAR_CRDT_PROTOCOL_VERSION,
    type RallarCrdtAdminReadRepository,
    type RallarCrdtCatchUpResponseEnvelope,
    type RallarCrdtDocumentRef
} from '@shared/crdt/mod.ts';

import { toApiMutationFailureResponse } from '../routes/api-mutation-route-failure.ts';
import { readApiMutationRouteRequestId } from '../routes/api-mutation-route-ingress.ts';
import { toAuthErrorResponse, toAuthSession } from '../services/request-auth-service.ts';
import {
    decodeCrdtAdminJsonObject,
    decodeCrdtCatchUpRequest,
    decodeCrdtDebugExportRequest,
    decodeCrdtDocumentRequest,
    decodeCrdtListDocumentsInput,
    type CrdtCatchUpRouteRequest
} from './crdt-admin-route-request-codec.ts';
import type { CrdtAdminMutationOperation, CrdtAdminMutations } from './create-crdt-admin-mutations.ts';

export interface RallarCrdtAdminAuthorizationInput {
    readonly session: AuthSession;
    readonly context: Context;
}

export interface RallarCrdtCatchUpAuthorizationInput {
    readonly document: RallarCrdtDocumentRef;
    readonly session: AuthSession;
}

export interface RallarCrdtCatchUpAuthorizationDecision {
    readonly allowed: boolean;
}

export interface CrdtAdminRouteDependencies {
    readonly repository: RallarCrdtAdminReadRepository;
    readonly crdtAdminMutations: CrdtAdminMutations;
    readonly now?: () => number;
    readonly requireAuth?: boolean;
    readonly adminClientIds?: readonly string[];
    readonly authorizeAdmin?: (
        input: RallarCrdtAdminAuthorizationInput
    ) => boolean | Promise<boolean>;
    readonly requireApiAdminSession: (context: Context) => Promise<IssuedAuthSession>;
    readonly requireApiUserSession: (context: Context) => Promise<IssuedAuthSession>;
    readonly authorizeCatchUp?: (
        input: RallarCrdtCatchUpAuthorizationInput
    ) => Promise<RallarCrdtCatchUpAuthorizationDecision>;
}

interface ProcessCrdtAdminMutationInput {
    readonly adminSession: AuthSession;
    readonly dependencies: CrdtAdminRouteDependencies;
    readonly operation: CrdtAdminMutationOperation;
    readonly requestId: string;
    readonly request: JsonWireObject;
}

interface CrdtAdminMutationRoute {
    readonly operation: CrdtAdminMutationOperation;
    readonly path: string;
}

const CRDT_ADMIN_MUTATION_ROUTES: readonly CrdtAdminMutationRoute[] = [
    {
        operation: 'rebuild-projection',
        path: '/api/crdt/admin/documents/rebuild-projection'
    },
    { operation: 'compact', path: '/api/crdt/admin/documents/compact' },
    { operation: 'lifecycle', path: '/api/crdt/admin/documents/lifecycle' },
    { operation: 'erase', path: '/api/crdt/admin/documents/erase' }
];

export function registerCrdtAdminRoutes(
    app: Hono,
    dependencies: CrdtAdminRouteDependencies
): void {
    const requireAuth = dependencies.requireAuth ?? true;
    registerCrdtAdminAuthorization(app, dependencies, requireAuth);
    registerCrdtCatchUpRoute(app, dependencies, requireAuth);
    registerCrdtAdminReadRoutes(app, dependencies);
    registerCrdtAdminMutationRoutes(app, dependencies);
}

function registerCrdtAdminAuthorization(
    app: Hono,
    dependencies: CrdtAdminRouteDependencies,
    requireAuth: boolean
): void {
    if (!requireAuth) {
        return;
    }
    app.use('/api/crdt/admin/*', async (context, next) => {
        if (isCrdtAdminMutationPath(context.req.path)) {
            await next();
            return;
        }
        try {
            await requireCrdtAdminSession(context, dependencies);
            await next();
        }
        catch (error) {
            return toAuthErrorResponse(context, error);
        }
    });
}

function registerCrdtCatchUpRoute(
    app: Hono,
    dependencies: CrdtAdminRouteDependencies,
    requireAuth: boolean
): void {
    app.post('/api/crdt/catch-up', async (context) => {
        const session = requireAuth ? await readCrdtCatchUpSession(context, dependencies) : undefined;
        if (session instanceof Response) {
            return session;
        }
        return await withAdminError(context, async () => {
            const request = decodeCrdtCatchUpRequest(await readJson(context));
            await requireCrdtCatchUpAuthorization(request.document, session, dependencies);
            return await readCrdtCatchUpResponse(dependencies, request);
        });
    });
}

function registerCrdtAdminReadRoutes(
    app: Hono,
    dependencies: CrdtAdminRouteDependencies
): void {
    app.post(
        '/api/crdt/admin/documents/list',
        (context) =>
            withAdminError(context, async () =>
                await dependencies.repository.listDocuments(
                    decodeCrdtListDocumentsInput(await readJson(context))
                ))
    );
    app.post(
        '/api/crdt/admin/documents/integrity',
        (context) =>
            withAdminError(context, async () =>
                await dependencies.repository.verifyIntegrity(
                    decodeCrdtDocumentRequest(await readJson(context))
                ))
    );
    app.post(
        '/api/crdt/admin/documents/debug-export',
        (context) => withAdminError(context, async () => await exportCrdtDebugBundle(context, dependencies))
    );
    app.post(
        '/api/crdt/admin/documents/backup-export',
        (context) =>
            withAdminError(context, async () =>
                await dependencies.repository.exportBackupBundle(
                    decodeCrdtDocumentRequest(await readJson(context))
                ))
    );
}

function registerCrdtAdminMutationRoutes(
    app: Hono,
    dependencies: CrdtAdminRouteDependencies
): void {
    for (const route of CRDT_ADMIN_MUTATION_ROUTES) {
        app.post(`${route.path}/requests/:requestId`, async (context) => {
            try {
                const adminSession = await requireCrdtAdminSession(context, dependencies);
                const request = await readMutationJson(context);
                const requestId = readApiMutationRouteRequestId({
                    requestId: context.req.param('requestId'),
                    idempotencyKey: context.req.header('idempotency-key'),
                    mutationBody: request
                });
                const result = await processCrdtAdminMutation({
                    adminSession,
                    dependencies,
                    operation: route.operation,
                    requestId,
                    request
                });
                return context.json({ ok: true, result });
            }
            catch (error) {
                return toApiMutationFailureResponse(context, toError(error));
            }
        });
    }
}

async function exportCrdtDebugBundle(
    context: Context,
    dependencies: CrdtAdminRouteDependencies
) {
    const request = decodeCrdtDebugExportRequest(await readJson(context));
    return await dependencies.repository.exportDebugBundle(request.document, {
        reason: request.reason ?? 'api-v1-admin-export',
        redaction: request.redactPayloads === false ? { payloadsRedacted: false } : {
            payloadsRedacted: true,
            reason: 'api-v1-admin-redaction'
        }
    });
}

async function processCrdtAdminMutation(
    input: ProcessCrdtAdminMutationInput
) {
    return await input.dependencies.crdtAdminMutations.writeCrdtAdminMutation({
        operation: input.operation,
        adminSession: input.adminSession,
        requestId: input.requestId,
        request: input.request
    });
}

function isCrdtAdminMutationPath(path: string): boolean {
    return CRDT_ADMIN_MUTATION_ROUTES.some((route) =>
        path === route.path || path.startsWith(`${route.path}/requests/`)
    );
}

async function readCrdtCatchUpSession(
    context: Context,
    dependencies: CrdtAdminRouteDependencies
): Promise<AuthSession | Response> {
    try {
        return toAuthSession(await dependencies.requireApiUserSession(context));
    }
    catch (error) {
        return toAuthErrorResponse(context, error);
    }
}

async function requireCrdtCatchUpAuthorization(
    document: RallarCrdtDocumentRef,
    session: AuthSession | undefined,
    dependencies: CrdtAdminRouteDependencies
): Promise<void> {
    if (!session || !dependencies.authorizeCatchUp) {
        return;
    }
    const decision = await dependencies.authorizeCatchUp({ document, session });
    if (!decision.allowed) {
        throw forbidden('CRDT catch-up authorization required.');
    }
}

function forbidden(message: string): Error {
    return Object.assign(new Error(`Forbidden: ${message}`), { status: 403 });
}

async function withAdminError<TResult>(
    context: Context,
    execute: () => Promise<TResult>
): Promise<Response> {
    try {
        const result = await execute();
        return context.json({ ok: true, result });
    }
    catch (error) {
        return context.json(
            {
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            },
            readErrorStatus(error)
        );
    }
}

async function requireCrdtAdminSession(
    context: Context,
    dependencies: CrdtAdminRouteDependencies
): Promise<AuthSession> {
    const session = await dependencies.requireApiAdminSession(context);
    const authorized = await isCrdtAdminSessionAuthorized(session, context, dependencies);
    if (!authorized) {
        throw forbidden('CRDT admin authorization required.');
    }
    return session;
}

async function isCrdtAdminSessionAuthorized(
    session: AuthSession,
    context: Context,
    dependencies: CrdtAdminRouteDependencies
): Promise<boolean> {
    if (dependencies.authorizeAdmin) {
        return await dependencies.authorizeAdmin({ session, context });
    }
    if (dependencies.adminClientIds) {
        return dependencies.adminClientIds.includes(session.clientId);
    }
    return true;
}

function readErrorStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 429 | 503 {
    if (!error || typeof error !== 'object' || !('status' in error)) {
        return 400;
    }
    const status = Number(Reflect.get(error, 'status'));
    switch (status) {
        case 401:
        case 403:
        case 404:
        case 409:
        case 429:
        case 503:
            return status;
        default:
            return 400;
    }
}

async function readJson(context: Context): Promise<JsonWireObject> {
    try {
        return decodeCrdtAdminJsonObject(
            decodeJsonWireValue(await context.req.json(), 'JSON request body'),
            'JSON request body'
        );
    }
    catch {
        return {};
    }
}

async function readMutationJson(context: Context): Promise<JsonWireObject> {
    return decodeCrdtAdminJsonObject(
        decodeJsonWireValue(await context.req.json(), 'CRDT admin mutation request'),
        'CRDT admin mutation request'
    );
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

async function readCrdtCatchUpResponse(
    dependencies: CrdtAdminRouteDependencies,
    request: CrdtCatchUpRouteRequest
): Promise<RallarCrdtCatchUpResponseEnvelope> {
    const page = await dependencies.repository.listAfter({
        document: request.document,
        afterSequence: request.afterSequence,
        afterCursor: request.afterCursor,
        limit: request.maxUpdateCount
    });
    const snapshot = request.includeSnapshot === false
        ? undefined
        : await dependencies.repository.readSnapshot(request.document);
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        requestId: request.requestId ?? crypto.randomUUID(),
        document: request.document,
        createdAtEpochMs: dependencies.now?.() ?? Date.now(),
        snapshot,
        page
    };
}
