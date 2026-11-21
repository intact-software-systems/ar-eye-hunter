import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
import {
    BrowserALSessionChannel,
    openBrowserALSessionChannelPort
} from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import {
    BrowserPageLifecycleFlush,
    readBrowserPageLifecycle
} from '@shared-web/browser/al-runtime/browser-page-lifecycle-flush.ts';
import { readApiBaseUrl } from '@shared-web/browser/api-client-config.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
import {
    initialiseMiddleware,
    type BrowserConnectedMiddleware,
    type BrowserConnectOptions,
    type MiddlewareInitOptions
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarRtcIceConfigRefreshOptions } from '@shared-web/browser/rallar-rtc-facade.ts';
import { readALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';
import {
    AppTopics,
    type AuthSession,
    type IceConfig
} from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { LoanedValue } from '@shared/cache/LoanedValue.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { BrowserDeliverySettlements } from './browser-delivery-settlements.ts';
import {
    closeBrowserTransportResources,
    reportBrowserConnectionCleanupFailure
} from './close-browser-transport-resources.ts';
import { readIceCandidates } from './connection-http-api.ts';
import { createBrowserConnectionReservation } from './create-browser-connection-reservation.ts';
import { checkRtcCaptureCompatibility } from './rallar-rtc-capture-connection-required-error.ts';
import type { BrowserServerClockSession } from './server-clock/browser-server-clock-session.ts';

/** The middleware's options with this tab's delivery observers, which the transport fences per connect. */
export interface BrowserTransportInitOptions extends Omit<MiddlewareInitOptions, 'deliverySettlements'> {
    readonly deliverySettlements: BrowserDeliverySettlements.Observers;
}

export interface BrowserTransportRuntimePort {
    readonly deliverySettlements: BrowserDeliverySettlements;
    readRtcCaptureConfiguration(): RtcSignalingDiagnostics.CaptureConfiguration | undefined;
    readRtcCaptureReceipt(): RtcSignalingDiagnostics.CaptureReceipt | undefined;
    readConnection(): BrowserTransportRuntime.Connection | undefined;
    readMiddleware(): ApiMiddleware | undefined;
    requireMiddleware(): ApiMiddleware;
    isReady(): boolean;
    isInitializing(): boolean;
    init(options: BrowserTransportInitOptions): Promise<BrowserTransportRuntime.Connection>;
    refreshIceConfig(options?: RallarRtcIceConfigRefreshOptions): Promise<void>;
    shutdown(reason?: string): void;
}

export namespace BrowserTransportRuntime {
    /** One connect's middleware as the facade holds it, and the checkpoints its page lifecycle flushes. */
    export interface Construction {
        readonly serverClock: BrowserServerClockSession.Port;
        readonly middleware: ApiMiddleware;
        readonly diagnosticsPorts: RallarDiagnosticsPorts;
        readonly rtcCaptureReceipt: RtcSignalingDiagnostics.CaptureReceipt;
        readonly checkpoints: BrowserConnectedMiddleware['checkpoints'];
    }

    export interface Connection {
        readonly serverClock: BrowserServerClockSession.Port;
        readonly middleware: ApiMiddleware;
        /** Immutable ports supplied to this middleware's initializer, retained across cached reuse. */
        readonly diagnosticsPorts: RallarDiagnosticsPorts;
        readonly rtcCapture: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>;
    }

    export interface Input {
        /** Opens each connect's session channel to the session's other tabs. */
        readonly openSessionChannelPort: BrowserALSessionChannel.OpenPort;
    }

    export interface IceAcquisition {
        readonly session: AuthSession;
        readonly generation: number;
        readonly apiBaseUrl: string;
    }

    export interface PendingConnection extends BrowserTransportRuntime.IceAcquisition {
        readonly durableWork: BrowserALDurableWorkClaim;
    }

    export interface OwnershipInput {
        readonly session: AuthSession;
        readonly scope: StateScope;
        readonly observers: BrowserDeliverySettlements.Observers;
        readonly signal: AbortSignal;
    }

    export interface Ownership {
        readonly durableWork: BrowserALDurableWorkClaim;
        readonly epoch: BrowserDeliverySettlements.Epoch;
    }
}

export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
    readonly deliverySettlements = new BrowserDeliverySettlements();
    private readonly input: BrowserTransportRuntime.Input;
    private activeConnection: BrowserTransportRuntime.Connection | undefined;
    private activeDurableWork: BrowserALDurableWorkClaim | undefined;
    private activePageLifecycle: BrowserPageLifecycleFlush | undefined;
    private pendingConnection: Promise<BrowserTransportRuntime.Connection> | undefined;
    private connectionLifetime: AbortController | undefined;
    private generation = 0;
    private iceCandidates: LoanedValue<IceConfig> | undefined;
    private iceApiBaseUrl: string | undefined;
    private icePendingAuthSessionKey: string | undefined;
    private rtcCaptureConfiguration: RtcSignalingDiagnostics.CaptureConfiguration | undefined;

    constructor(input: BrowserTransportRuntime.Input) {
        this.input = input;
    }

    public readRtcCaptureConfiguration(): RtcSignalingDiagnostics.CaptureConfiguration | undefined {
        return this.rtcCaptureConfiguration;
    }

    public readRtcCaptureReceipt(): RtcSignalingDiagnostics.CaptureReceipt | undefined {
        const rtcCapture = this.activeConnection?.rtcCapture;
        return rtcCapture?.status === 'observed' ? rtcCapture.value : undefined;
    }

    public readConnection(): BrowserTransportRuntime.Connection | undefined {
        return this.activeConnection;
    }

    public readMiddleware(): ApiMiddleware | undefined {
        return this.activeConnection?.middleware;
    }

    public requireMiddleware(): ApiMiddleware {
        const middleware = this.readMiddleware();
        if (!middleware) {
            throw new Error('Rallar is not connected. Call rallar.connect() first.');
        }

        return middleware;
    }

    public isReady(): boolean {
        return this.activeConnection !== undefined;
    }

    public isInitializing(): boolean {
        return this.pendingConnection !== undefined;
    }

    public async refreshIceConfig(options: RallarRtcIceConfigRefreshOptions = {}): Promise<void> {
        const session = readSession();
        if (!session) {
            throw new Error('Cannot refresh ICE configuration: no auth session.');
        }
        const acquisition: BrowserTransportRuntime.IceAcquisition = {
            session,
            generation: this.generation,
            apiBaseUrl: readApiBaseUrl()
        };
        await new Command(async (signal) => {
            const cache = this.readIceCache(acquisition, signal);
            cache.clear();
            await this.readCachedIceCandidates(acquisition, cache, signal);
        }, { ...options, errorOnNull: false }).run();
    }

    public init(options: BrowserTransportInitOptions): Promise<BrowserTransportRuntime.Connection> {
        const compatibility = checkRtcCaptureCompatibility({
            requested: options.rtcCaptureConfiguration,
            current: this.rtcCaptureConfiguration,
            currentReceipt: this.readRtcCaptureReceipt()
        });
        if (compatibility.left) {
            return Promise.reject(compatibility.left);
        }
        if (this.activeConnection) {
            return Promise.resolve(this.activeConnection);
        }

        if (this.pendingConnection) {
            return this.pendingConnection;
        }

        const session = readSession();
        if (!session) {
            return Promise.reject(new Error('Cannot init middleware: no auth session.'));
        }
        const rtcCaptureConfiguration = Object.freeze({ ...options.rtcCaptureConfiguration });
        const reservation = createBrowserConnectionReservation();
        this.rtcCaptureConfiguration = rtcCaptureConfiguration;
        this.pendingConnection = reservation.promise;
        try {
            reservation.settle(
                this.startConnection(session, { ...options, rtcCaptureConfiguration }, reservation.promise)
            );
            return reservation.promise;
        }
        catch (error) {
            if (this.pendingConnection === reservation.promise) {
                const lifetime = this.connectionLifetime;
                this.connectionLifetime = undefined;
                this.pendingConnection = undefined;
                this.rtcCaptureConfiguration = undefined;
                lifetime?.abort(error);
            }
            // The caller still receives the original synchronous throw; a reentrant waiter receives the same rejection.
            void reservation.promise.catch(() => undefined);
            reservation.settle(Promise.reject(error));
            throw error;
        }
    }

    private startConnection(
        session: AuthSession,
        options: BrowserTransportInitOptions,
        pendingConnection: Promise<BrowserTransportRuntime.Connection>
    ): Promise<BrowserTransportRuntime.Connection> {
        const generation = this.generation;
        const apiBaseUrl = readApiBaseUrl();
        const lifetime = new AbortController();
        const callerSignal = options.signal;
        callerSignal?.throwIfAborted();
        const cancelStartup = (): void => lifetime.abort(callerSignal?.reason);
        callerSignal?.addEventListener('abort', cancelStartup, { once: true, signal: lifetime.signal });
        const releaseCallerSignal = (): void => callerSignal?.removeEventListener('abort', cancelStartup);
        this.connectionLifetime = lifetime;
        const { durableWork, epoch } = this.openConnectionOwnership({
            session,
            scope: options.scope ?? defaultStateScope(),
            observers: options.deliverySettlements,
            signal: lifetime.signal
        });
        const connection: BrowserTransportRuntime.PendingConnection = { session, generation, apiBaseUrl, durableWork };
        return this.createMiddleware(session, {
            ...options,
            signal: lifetime.signal,
            readIceCandidates: (signal) => this.readConnectionIceCandidates(connection, signal),
            deliverySettlements: epoch.settlements,
            durableWorkOwnership: durableWork
        })
            .then((connected) => this.acceptConnection(connected, connection, releaseCallerSignal))
            .catch((error) => {
                if (this.connectionLifetime === lifetime) {
                    this.connectionLifetime = undefined;
                }
                lifetime.abort(error);
                if (connection.generation === this.generation) {
                    this.rtcCaptureConfiguration = undefined;
                }
                epoch.close();
                durableWork.release();
                throw error;
            })
            .finally(() => {
                if (this.pendingConnection === pendingConnection) {
                    this.pendingConnection = undefined;
                }
            });
    }

    private acceptConnection(
        connected: BrowserTransportRuntime.Construction,
        connection: BrowserTransportRuntime.PendingConnection,
        releaseCallerSignal: () => void
    ): BrowserTransportRuntime.Connection {
        const currentSession = readSession();
        if (
            connection.generation !== this.generation || !currentSession ||
            toAuthSessionKey(currentSession) !== toAuthSessionKey(connection.session)
        ) {
            this.shutdownMiddleware(connected);
            throw new Error('Rallar connection was cancelled because auth ended.');
        }
        if (connected.serverClock.signal.aborted) {
            this.shutdownMiddleware(connected, 'server-clock-unavailable');
            throw new Error('Rallar connection was cancelled because server clock calibration ended.');
        }
        const connectionResult: BrowserTransportRuntime.Connection = Object.freeze({
            serverClock: connected.serverClock,
            middleware: connected.middleware,
            diagnosticsPorts: connected.diagnosticsPorts,
            rtcCapture: Object.freeze({ status: 'observed', value: connected.rtcCaptureReceipt })
        });
        releaseCallerSignal();
        this.activeConnection = connectionResult;
        this.activeDurableWork = connection.durableWork;
        this.activePageLifecycle = new BrowserPageLifecycleFlush({
            page: readBrowserPageLifecycle(),
            ownership: connection.durableWork,
            checkpoints: connected.checkpoints
        });
        const endClockConnection = (): void => {
            if (this.activeConnection === connectionResult) {
                try {
                    this.activePageLifecycle?.flush();
                }
                finally {
                    this.shutdown('server-clock-unavailable');
                }
            }
        };
        connected.serverClock.signal.addEventListener('abort', endClockConnection, { once: true });
        if (connected.serverClock.signal.aborted) {
            endClockConnection();
            connected.serverClock.signal.throwIfAborted();
        }
        return connectionResult;
    }

    public shutdown(reason = 'rallar-disconnect'): void {
        this.deliverySettlements.close();
        this.generation += 1;
        if (this.iceCandidates?.refreshing()) {
            this.iceCandidates = undefined;
            this.icePendingAuthSessionKey = undefined;
        }
        this.pendingConnection = undefined;
        this.rtcCaptureConfiguration = undefined;
        const connection = this.activeConnection;
        const lifetime = this.connectionLifetime;
        this.connectionLifetime = undefined;
        const durableWork = this.activeDurableWork;
        this.activePageLifecycle?.release();
        this.activeConnection = undefined;
        this.activeDurableWork = undefined;
        this.activePageLifecycle = undefined;

        lifetime?.abort(new Error(`Rallar connection was cancelled: ${reason}.`));
        if (connection) {
            this.shutdownMiddleware(connection, reason);
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

    private readConnectionIceCandidates(
        acquisition: BrowserTransportRuntime.IceAcquisition,
        signal?: AbortSignal
    ): Promise<IceConfig> {
        const cache = this.readIceCache(acquisition, signal);
        return this.readCachedIceCandidates(acquisition, cache, signal);
    }

    private readIceCache(
        acquisition: BrowserTransportRuntime.IceAcquisition,
        signal?: AbortSignal
    ): LoanedValue<IceConfig> {
        this.assertIceAcquisitionCurrent(acquisition, signal);
        if (
            !this.iceCandidates || this.iceApiBaseUrl !== acquisition.apiBaseUrl ||
            (this.iceCandidates.refreshing() && this.icePendingAuthSessionKey !== toAuthSessionKey(acquisition.session))
        ) {
            this.iceCandidates = this.createIceCandidates(acquisition.apiBaseUrl);
            this.iceApiBaseUrl = acquisition.apiBaseUrl;
        }
        return this.iceCandidates;
    }

    private async readCachedIceCandidates(
        acquisition: BrowserTransportRuntime.IceAcquisition,
        cache: LoanedValue<IceConfig>,
        signal?: AbortSignal
    ): Promise<IceConfig> {
        const retire = () => {
            if (this.iceCandidates === cache) {
                this.iceCandidates = undefined;
                this.icePendingAuthSessionKey = undefined;
            }
        };
        try {
            const value = await cache.getWith(() => {
                this.icePendingAuthSessionKey = toAuthSessionKey(acquisition.session);
                signal?.addEventListener('abort', retire, { once: true });
                return this.readFreshIceCandidates(acquisition, cache, signal);
            });
            this.assertIceAcquisitionCurrent(acquisition, signal);
            if (this.iceCandidates !== cache) {
                throw new Error('ICE configuration acquisition was cancelled because its cache was replaced.');
            }
            return value;
        }
        finally {
            signal?.removeEventListener('abort', retire);
            if (this.iceCandidates === cache && !cache.refreshing()) {
                this.icePendingAuthSessionKey = undefined;
            }
        }
    }

    private createIceCandidates(apiBaseUrl: string): LoanedValue<IceConfig> {
        return new LoanedValue(() => readIceCandidates(undefined, apiBaseUrl), {
            isValid: (value, nowEpochMs) => value.expiresAtEpochMs > nowEpochMs
        });
    }

    private async readFreshIceCandidates(
        acquisition: BrowserTransportRuntime.IceAcquisition,
        cache: LoanedValue<IceConfig>,
        signal?: AbortSignal
    ): Promise<IceConfig> {
        const iceCandidates = await readIceCandidates({ signal }, acquisition.apiBaseUrl);
        this.assertIceAcquisitionCurrent(acquisition, signal);
        if (this.iceCandidates !== cache) {
            throw new Error('ICE configuration acquisition was cancelled because its cache was replaced.');
        }
        return iceCandidates;
    }

    private assertIceAcquisitionCurrent(
        acquisition: BrowserTransportRuntime.IceAcquisition,
        signal?: AbortSignal
    ): void {
        signal?.throwIfAborted();
        const currentSession = readSession();
        if (
            acquisition.generation !== this.generation || !currentSession ||
            toAuthSessionKey(currentSession) !== toAuthSessionKey(acquisition.session)
        ) {
            throw new Error('Rallar connection was cancelled because auth ended.');
        }
    }

    /** Requested once per connect, in the connect's scope; held, with the connect's session channel, until the connect ends. */
    private openConnectionOwnership(input: BrowserTransportRuntime.OwnershipInput): BrowserTransportRuntime.Ownership {
        input.signal.throwIfAborted();
        const sessionChannel = this.openSessionChannel(input.scope, input.session, input.observers);
        const durableWork = new BrowserALDurableWorkClaim({
            scope: input.scope,
            sessionId: input.session.sessionId,
            locks: readALBrowserLocks(),
            sessionChannel
        });
        try {
            input.signal.throwIfAborted();
            durableWork.request();
            input.signal.throwIfAborted();
            const epoch = this.deliverySettlements.open(input.observers, sessionChannel);
            return { durableWork, epoch };
        }
        catch (caught) {
            try {
                durableWork.release();
            }
            catch (failure) {
                reportBrowserConnectionCleanupFailure(toError(failure));
            }
            throw caught;
        }
    }

    private async createMiddleware(
        session: AuthSession,
        options: BrowserConnectOptions
    ): Promise<BrowserTransportRuntime.Construction> {
        const diagnosticsPorts = Object.freeze({ ...options.diagnosticsPorts });
        const { middleware, checkpoints, rtcCaptureReceipt, serverClock } = await initialiseMiddleware(
            session,
            AppTopics.rtcSignaling,
            { ...options, diagnosticsPorts }
        );

        return {
            middleware: {
                session,
                middleware,
                serverTime: {
                    readWindow: () => serverClock.readWindow(),
                    readWorkEpochMs: () => serverClock.readWorkEpochMs()
                }
            },
            diagnosticsPorts,
            checkpoints,
            rtcCaptureReceipt,
            serverClock
        };
    }

    private shutdownMiddleware(
        connection: Pick<BrowserTransportRuntime.Connection, 'middleware' | 'serverClock'>,
        reason = 'rallar-disconnect'
    ): void {
        void closeBrowserTransportResources({
            ...connection.middleware.middleware,
            serverClock: connection.serverClock
        }, reason).catch(() => {
            // Immediate shutdown contains cleanup failures while allowing durable claim transfer.
        });
    }
}

export const browserTransportRuntime = new BrowserTransportRuntime({
    openSessionChannelPort: openBrowserALSessionChannelPort
});
