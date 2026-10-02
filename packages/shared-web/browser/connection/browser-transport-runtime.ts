import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
import {
    BrowserALSessionChannel,
    openBrowserALSessionChannelPort
} from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
import {
    initialiseMiddleware,
    type BrowserConnectOptions,
    type MiddlewareInitOptions
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type { ApiMiddleware, RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { readALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';
import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { BrowserDeliverySettlements } from './browser-delivery-settlements.ts';

/** The middleware's options with this tab's delivery observers, which the transport fences per connect. */
export interface BrowserTransportInitOptions extends Omit<MiddlewareInitOptions, 'deliverySettlements'> {
    readonly deliverySettlements: BrowserDeliverySettlements.Observers;
}

export interface BrowserTransportRuntimePort {
    readonly deliverySettlements: BrowserDeliverySettlements;
    readMiddleware(): ApiMiddleware | undefined;
    requireMiddleware(): ApiMiddleware;
    isReady(): boolean;
    isInitializing(): boolean;
    init(options: BrowserTransportInitOptions): Promise<ApiMiddleware>;
    shutdown(reason?: string): void;
}

export namespace BrowserTransportRuntime {
    export interface Input {
        /** Opens each connect's session channel to the session's other tabs. */
        readonly openSessionChannelPort: BrowserALSessionChannel.OpenPort;
    }
}

export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
    readonly deliverySettlements = new BrowserDeliverySettlements();
    private readonly input: BrowserTransportRuntime.Input;
    private activeMiddleware: ApiMiddleware | undefined;
    private activeDurableWork: BrowserALDurableWorkClaim | undefined;
    private pendingMiddleware: Promise<ApiMiddleware> | undefined;
    private generation = 0;

    constructor(input: BrowserTransportRuntime.Input) {
        this.input = input;
    }

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

    public init(options: BrowserTransportInitOptions): Promise<ApiMiddleware> {
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

        const scope = options.scope ?? defaultStateScope();
        const sessionChannel = this.openSessionChannel(scope, session, options.deliverySettlements);
        const durableWork = this.claimDurableWork(scope, session, sessionChannel);
        const epoch = this.deliverySettlements.open(options.deliverySettlements, sessionChannel);
        const pendingMiddleware = this.createMiddleware(session, {
            ...options,
            deliverySettlements: epoch.settlements,
            durableWorkOwnership: durableWork
        })
            .then((middleware) => {
                const currentSession = readSession();
                if (
                    generation !== this.generation ||
                    !currentSession ||
                    toAuthSessionKey(currentSession) !== toAuthSessionKey(session)
                ) {
                    this.shutdownMiddleware(middleware.middleware);
                    throw new Error('Rallar connection was cancelled because auth ended.');
                }

                this.activeMiddleware = middleware;
                this.activeDurableWork = durableWork;
                return middleware;
            })
            .catch((error) => {
                epoch.close();
                durableWork.release();
                throw error;
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
        this.deliverySettlements.close();
        this.generation += 1;
        this.pendingMiddleware = undefined;
        const middleware = this.activeMiddleware;
        const durableWork = this.activeDurableWork;
        this.activeMiddleware = undefined;
        this.activeDurableWork = undefined;

        if (middleware) {
            this.shutdownMiddleware(middleware.middleware, reason);
        }
        // Released after the runtimes stop, so the next owner's takeover starts after them; a batch still in
        // flight is not awaited, and its rows' leases keep each row once.
        durableWork?.release();
    }

    private openSessionChannel(
        scope: StateScope,
        session: AuthSession,
        observers: BrowserDeliverySettlements.Observers
    ): BrowserALSessionChannel {
        return new BrowserALSessionChannel({
            scope,
            sessionId: session.sessionId,
            instanceId: crypto.randomUUID(),
            openPort: this.input.openSessionChannelPort,
            applySettlement: (settlement) => observers[settlement.carrier](settlement)
        });
    }

    /** Requested once per connect, in the connect's scope; held, with the connect's session channel, until the connect ends. */
    private claimDurableWork(
        scope: StateScope,
        session: AuthSession,
        sessionChannel: BrowserALSessionChannel
    ): BrowserALDurableWorkClaim {
        const durableWork = new BrowserALDurableWorkClaim({
            scope,
            sessionId: session.sessionId,
            locks: readALBrowserLocks(),
            sessionChannel
        });
        durableWork.request();
        return durableWork;
    }

    private async createMiddleware(
        session: AuthSession,
        options: BrowserConnectOptions
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

    private shutdownMiddleware(
        middleware: RallarBrowserMiddleware,
        reason = 'rallar-disconnect'
    ): void {
        runShutdownStep(() => middleware.heartbeat?.stop());
        runShutdownStep(() => middleware.rtcRxStreamer.dispose());
        runShutdownStep(() => middleware.webRtcGroupManager.stopReconcileWakes());
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

function runShutdownStep(step: () => void): void {
    try {
        step();
    }
    catch {
        // Transport cleanup must continue when a stale resource is already closed.
    }
}

export const browserTransportRuntime = new BrowserTransportRuntime({
    openSessionChannelPort: openBrowserALSessionChannelPort
});
