import { readSession } from '@shared/api/auth.ts';
import * as middleware from '@shared-web/browser/middleware.ts';
import { Middleware, type MiddlewareInitOptions } from '@shared-web/browser/middleware.ts';
import { AppTopics, AuthSession } from '@shared/api/api-config.ts';

export type ApiMiddleware = {
    readonly session: AuthSession;
    readonly authFetch: (
        input: RequestInfo | URL,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly middleware: Middleware;
};

let ctx: ApiMiddleware | undefined = undefined;
let initPromise: Promise<ApiMiddleware> | undefined = undefined;

export type InitMiddlewareOptions = MiddlewareInitOptions;

export function getMiddleware(): ApiMiddleware {
    if (!ctx) {
        throw new Error('Middleware not initialized. User not logged in.');
    }

    return ctx;
}

export function isMiddlewareReady(): boolean {
    return ctx !== undefined;
}

export async function initMiddleware(
    options: InitMiddlewareOptions = {},
): Promise<ApiMiddleware> {
    // Fast path: already initialized
    if (ctx) {
        return ctx;
    }

    // Single-flight: if an initialization is already in progress, await it
    if (initPromise) {
        return await initPromise;
    }

    initPromise = (async () => {
        const session = readSession();
        if (!session) {
            throw new Error('Cannot init middleware: no auth session.');
        }

        // Build an auth-aware fetch wrapper (or a richer client)
        const authFetch: ApiMiddleware['authFetch'] = (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set('authorization', `Bearer ${session.accessToken}`);
            headers.set('x-client-id', session.clientId);
            return fetch(input, { ...init, headers });
        };

        const mw = await middleware.initialiseMiddleware(
            session,
            AppTopics.rtcSignaling,
            options,
        );

        ctx = {
            session,
            authFetch,
            middleware: mw,
        };

        return ctx;
    })();

    try {
        return await initPromise;
    } catch (e) {
        // If init failed, allow a future retry
        initPromise = undefined;
        throw e;
    }
}

export function clearMiddleware(): void {
    ctx?.middleware.heartbeat?.stop();
    ctx = undefined;
    initPromise = undefined;
}
