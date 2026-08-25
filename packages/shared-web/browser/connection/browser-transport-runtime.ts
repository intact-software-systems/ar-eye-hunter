import { initialiseMiddleware, type Middleware, type MiddlewareInitOptions } from '@shared-web/browser/middleware.ts';
import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';

export interface ApiMiddleware {
    readonly session: AuthSession;
    readonly authFetch: (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => Promise<Response>;
    readonly middleware: Middleware;
}

export interface BrowserTransportRuntimePort {
    readMiddleware(): ApiMiddleware | undefined;
    requireMiddleware(): ApiMiddleware;
    isReady(): boolean;
    isInitializing(): boolean;
    init(options?: MiddlewareInitOptions): Promise<ApiMiddleware>;
    shutdown(reason?: string): void;
}

export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
    private activeMiddleware: ApiMiddleware | undefined;
    private pendingMiddleware: Promise<ApiMiddleware> | undefined;
    private generation = 0;

    public readMiddleware(): ApiMiddleware | undefined {
        return this.activeMiddleware;
    }

    public requireMiddleware(): ApiMiddleware {
        const middleware = this.readMiddleware();
        if (!middleware) {
            throw new Error('Rallar is not connected. Call rallar.connect() first.');
        }

        return middleware;
    }

    public isReady(): boolean {
        return this.activeMiddleware !== undefined;
    }

    public isInitializing(): boolean {
        return this.pendingMiddleware !== undefined;
    }

    public init(options: MiddlewareInitOptions = {}): Promise<ApiMiddleware> {
        if (this.activeMiddleware) {
            return Promise.resolve(this.activeMiddleware);
        }

        if (this.pendingMiddleware) {
            return this.pendingMiddleware;
        }

        const generation = this.generation;
        const session = readSession();
        if (!session) {
            return Promise.reject(new Error('Cannot init middleware: no auth session.'));
        }

        const pendingMiddleware = this.createMiddleware(session, options)
            .then((middleware) => {
                const currentSession = readSession();
                if (
                    generation !== this.generation ||
                    !currentSession ||
                    currentSession.sessionId !== session.sessionId
                ) {
                    this.shutdownMiddleware(middleware.middleware);
                    throw new Error('Rallar connection was cancelled because auth ended.');
                }

                this.activeMiddleware = middleware;
                return middleware;
            })
            .finally(() => {
                if (this.pendingMiddleware === pendingMiddleware) {
                    this.pendingMiddleware = undefined;
                }
            });

        this.pendingMiddleware = pendingMiddleware;
        return pendingMiddleware;
    }

    public shutdown(reason = 'rallar-disconnect'): void {
        this.generation += 1;
        this.pendingMiddleware = undefined;
        const middleware = this.activeMiddleware;
        this.activeMiddleware = undefined;

        if (middleware) {
            this.shutdownMiddleware(middleware.middleware, reason);
        }
    }

    private async createMiddleware(
        session: AuthSession,
        options: MiddlewareInitOptions
    ): Promise<ApiMiddleware> {
        const authFetch: ApiMiddleware['authFetch'] = (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set('authorization', `Bearer ${session.accessToken}`);
            headers.set('x-client-id', session.clientId);
            return fetch(input, { ...init, headers });
        };
        const middleware = await initialiseMiddleware(session, AppTopics.rtcSignaling, options);

        return { session, authFetch, middleware };
    }

    private shutdownMiddleware(middleware: Middleware, reason = 'rallar-disconnect'): void {
        runShutdownStep(() => middleware.heartbeat?.stop());
        runShutdownStep(() => middleware.rtcRxStreamer.stopAllHeartbeats());
        runShutdownStep(() => {
            for (const peerId of middleware.webRtcConnectionService.knownPeerIds()) {
                middleware.webRtcConnectionService.disconnectPeer(peerId);
            }
        });
        runShutdownStep(() => middleware.rtcRxStreamer.stopLocalMedia('all'));
        runShutdownStep(() => middleware.webRtcOverlayMulticastManager?.dispose?.());
        runShutdownStep(() => middleware.qboxEngine.stop());
        runShutdownStep(() => middleware.webSocketQueueBox.close(1000, reason));
    }
}

export const browserTransportRuntime = new BrowserTransportRuntime();

function runShutdownStep(step: () => void): void {
    try {
        step();
    }
    catch {
        // Transport cleanup must continue when a stale resource is already closed.
    }
}
