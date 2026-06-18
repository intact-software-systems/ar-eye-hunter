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
let middlewareGeneration = 0;

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

    const generation = middlewareGeneration;
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

        const currentSession = readSession();
        if (
            generation !== middlewareGeneration ||
            !currentSession ||
            currentSession.sessionId !== session.sessionId
        ) {
            shutdownMiddleware(mw);
            throw new Error('Cannot init middleware: auth session ended.');
        }

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
    middlewareGeneration += 1;
    shutdownMiddleware(ctx?.middleware);
    ctx = undefined;
    initPromise = undefined;
}

export function shutdownMiddleware(
    mw: Middleware | undefined,
    reason = 'rallar-disconnect',
): void {
    if (!mw) {
        return;
    }

    runShutdownStep(() => mw.heartbeat?.stop());
    runShutdownStep(() => mw.rtcRxStreamer.stopAllHeartbeats());
    runShutdownStep(() => {
        for (const peerId of mw.webRtcConnectionService.knownPeerIds()) {
            mw.webRtcConnectionService.disconnectPeer(peerId);
        }
    });
    runShutdownStep(() => mw.rtcRxStreamer.stopLocalMedia('all'));
    runShutdownStep(() => mw.webRtcOverlayMulticastManager?.dispose?.());
    runShutdownStep(() => mw.qboxEngine.stop());
    runShutdownStep(() => mw.webSocketQueueBox.close(1000, reason));
}

function runShutdownStep(step: () => void): void {
    try {
        step();
    } catch {
        // Shutdown is best-effort; callers are already tearing down auth state.
    }
}
