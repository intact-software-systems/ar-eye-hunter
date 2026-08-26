import type {
    AdminSupportUseCases,
    AdminSupportWriteInput
} from '@shared-server/rallar-system/admin-support/admin-support-contracts.ts';
import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { AdminSupportNarrativeResponse } from '@shared/api/admin-support/admin-support-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';

import {
    requireApiAdminSession as defaultRequireApiAdminSession,
    type ApiAdminAuthDependencies
} from '../services/admin-auth-service.ts';
import {
    decodeAdminSupportExplainClientRequest,
    decodeAdminSupportExplainCrdtDocumentRequest,
    decodeAdminSupportExplainGroupRequest,
    decodeAdminSupportExplainQueueItemRequest,
    decodeAdminSupportExplainRequestRequest
} from './admin-support-request-decoding.ts';

export interface AdminSupportRouteDependencies extends ApiAdminAuthDependencies {
    readonly support: AdminSupportUseCases;
    readonly requireApiAdminSession?: (
        request: { header(name: string): string | undefined; },
        dependencies: ApiAdminAuthDependencies
    ) => Promise<AuthSession>;
}

interface AdminSupportRouteRequest<TRequest> {
    readonly decode: (value: JsonWireValue) => TRequest;
    readonly write: (
        input: AdminSupportWriteInput<TRequest>
    ) => Promise<AdminSupportNarrativeResponse>;
}

export function registerAdminSupportRoutes(
    app: Hono,
    dependencies: AdminSupportRouteDependencies
): void {
    app.post(
        '/api/admin/support/explain/client',
        (context) =>
            respondToAdminSupportRequest(context, dependencies, {
                decode: decodeAdminSupportExplainClientRequest,
                write: (input) => dependencies.support.explainClient(input)
            })
    );

    app.post(
        '/api/admin/support/explain/group',
        (context) =>
            respondToAdminSupportRequest(context, dependencies, {
                decode: decodeAdminSupportExplainGroupRequest,
                write: (input) => dependencies.support.explainGroup(input)
            })
    );

    app.post(
        '/api/admin/support/explain/request',
        (context) =>
            respondToAdminSupportRequest(context, dependencies, {
                decode: decodeAdminSupportExplainRequestRequest,
                write: (input) => dependencies.support.explainRequest(input)
            })
    );

    app.post(
        '/api/admin/support/explain/crdt-document',
        (context) =>
            respondToAdminSupportRequest(context, dependencies, {
                decode: decodeAdminSupportExplainCrdtDocumentRequest,
                write: (input) => dependencies.support.explainCrdtDocument(input)
            })
    );

    app.post(
        '/api/admin/support/explain/queue-item',
        (context) =>
            respondToAdminSupportRequest(context, dependencies, {
                decode: decodeAdminSupportExplainQueueItemRequest,
                write: (input) => dependencies.support.explainQueueItem(input)
            })
    );
}

async function respondToAdminSupportRequest<TRequest>(
    context: Context,
    dependencies: AdminSupportRouteDependencies,
    routeRequest: AdminSupportRouteRequest<TRequest>
): Promise<Response> {
    try {
        const adminSession = await requireAdminSession(context, dependencies);
        const request = routeRequest.decode(await readOptionalJsonBody(context));
        return context.json(await routeRequest.write({ adminSession, request }));
    }
    catch (error) {
        return toErrorResponse(context, error);
    }
}

async function requireAdminSession(
    context: Context,
    dependencies: AdminSupportRouteDependencies
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
        return decodeJsonWireValue(
            await context.req.json(),
            'Admin support request body'
        );
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            const malformedJsonError = new Error('Malformed JSON request body') as Error & {
                status: number;
            };
            malformedJsonError.status = 400;
            throw malformedJsonError;
        }
        throw error;
    }
}

function toErrorResponse(
    context: { json(value: { readonly error: string; }, status?: number): Response; },
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

    return context.json({ error: message }, status);
}

function isStatusError(error: unknown): error is Error & { status: number; } {
    return error instanceof Error &&
        typeof (error as Error & { status?: number; }).status === 'number';
}
