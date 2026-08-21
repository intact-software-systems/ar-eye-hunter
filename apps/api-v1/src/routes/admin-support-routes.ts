import type { AuthSession } from '@shared/api/api-config.ts';
import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';
import {
    requireApiAdminSession as defaultRequireApiAdminSession,
    type ApiAdminAuthDependencies
} from '../services/admin-auth-service.ts';

export type AdminSupportWriteInput<TRequest> = Readonly<{
    adminSession: AuthSession;
    request: TRequest;
}>;

export type AdminSupportServiceLike = Readonly<{
    explainClient(input: AdminSupportWriteInput<unknown>): Promise<unknown>;
    explainGroup(input: AdminSupportWriteInput<unknown>): Promise<unknown>;
    explainRequest(input: AdminSupportWriteInput<unknown>): Promise<unknown>;
    explainCrdtDocument(input: AdminSupportWriteInput<unknown>): Promise<unknown>;
    explainQueueItem(input: AdminSupportWriteInput<unknown>): Promise<unknown>;
}>;

export type AdminSupportRouteDependencies = Readonly<
    ApiAdminAuthDependencies & {
        support: AdminSupportServiceLike;
        requireApiAdminSession?: (
            req: { header(name: string): string | undefined; },
            dependencies: ApiAdminAuthDependencies
        ) => Promise<AuthSession>;
    }
>;

export function init(
    app: Hono,
    dependencies: AdminSupportRouteDependencies
): void {
    const deps = dependencies;

    app.post(
        '/api/admin/support/explain/client',
        (c) =>
            withAdminJson(
                c,
                deps,
                (adminSession, request) => deps.support.explainClient({ adminSession, request })
            )
    );

    app.post(
        '/api/admin/support/explain/group',
        (c) =>
            withAdminJson(
                c,
                deps,
                (adminSession, request) => deps.support.explainGroup({ adminSession, request })
            )
    );

    app.post(
        '/api/admin/support/explain/request',
        (c) =>
            withAdminJson(
                c,
                deps,
                (adminSession, request) => deps.support.explainRequest({ adminSession, request })
            )
    );

    app.post(
        '/api/admin/support/explain/crdt-document',
        (c) =>
            withAdminJson(
                c,
                deps,
                (adminSession, request) => deps.support.explainCrdtDocument({ adminSession, request })
            )
    );

    app.post(
        '/api/admin/support/explain/queue-item',
        (c) =>
            withAdminJson(
                c,
                deps,
                (adminSession, request) => deps.support.explainQueueItem({ adminSession, request })
            )
    );
}

async function withAdminJson(
    c: Context,
    deps: AdminSupportRouteDependencies,
    execute: (session: AuthSession, request: unknown) => Promise<unknown>
): Promise<Response> {
    try {
        const adminSession = await requireAdminSession(c, deps);
        return c.json(await execute(adminSession, await readOptionalJsonBody(c)));
    }
    catch (error) {
        return toErrorResponse(c, error);
    }
}

async function requireAdminSession(
    c: Context,
    deps: AdminSupportRouteDependencies
): Promise<AuthSession> {
    return await (deps.requireApiAdminSession ?? defaultRequireApiAdminSession)(
        c.req,
        {
            adminClientIds: deps.adminClientIds,
            requireApiAuthSession: deps.requireApiAuthSession
        }
    );
}

async function readOptionalJsonBody(c: Context): Promise<unknown> {
    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
        return {};
    }

    try {
        return await c.req.json();
    }
    catch {
        const error = new Error('Malformed JSON request body') as Error & { status: number; };
        error.status = 400;
        throw error;
    }
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
