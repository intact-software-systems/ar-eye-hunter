import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
import type { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import type { BrowserRallarDeliveryRegistry } from './browser-rallar-delivery-registry.ts';

/** Owns volatile delivery observation for the browser's shared authenticated session. */
export class BrowserSessionDeliveries {
    readonly settle: ALDeliverySettlementSink;
    /** What each connect's epoch reports to: both carriers settle here, and the epoch relays what this tab does not hold. */
    readonly observers: BrowserDeliverySettlements.Observers;
    private sessionKey: string | undefined;
    private readonly sessionEndListeners = new Set<() => void>();
    private readonly deliveries: BrowserRallarDeliveryRegistry;
    private readonly transport: Pick<
        BrowserTransportRuntimePort,
        'deliverySettlements' | 'readMiddleware' | 'readRtcCaptureReceipt'
    >;
    private readonly readSession: () => AuthSession | undefined;

    constructor(
        deliveries: BrowserRallarDeliveryRegistry,
        transport: Pick<
            BrowserTransportRuntimePort,
            'deliverySettlements' | 'readMiddleware' | 'readRtcCaptureReceipt'
        >,
        readSession: () => AuthSession | undefined
    ) {
        this.deliveries = deliveries;
        this.transport = transport;
        this.readSession = readSession;
        this.settle = (event) => deliveries.record(event);
        this.observers = {
            ws: this.settle,
            rtc: this.settle,
            holds: (msgId) => deliveries.getHandle(msgId) !== undefined
        };
    }

    beginSession(session: AuthSession): void {
        if (this.matches(session)) {
            return;
        }
        this.releaseSession();
        this.sessionKey = toAuthSessionKey(session);
    }

    endSession(session: AuthSession): void {
        if (!this.matches(session)) {
            return;
        }
        this.releaseSession();
        this.sessionKey = undefined;
    }

    /** Runs synchronously at each session end, before the session's observations are released, so it can still settle them. */
    onSessionEnd(listener: () => void): RallarUnsubscribe {
        this.sessionEndListeners.add(listener);
        return () => this.sessionEndListeners.delete(listener);
    }

    capture(context: ApiMiddleware): BrowserDeliverySettlements.Epoch | undefined {
        if (this.transport.readMiddleware() !== context) {
            return undefined;
        }
        return this.transport.deliverySettlements.capture();
    }

    readRtcCapture(context: ApiMiddleware): RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt> {
        if (this.captureOwnershipFailure(context) !== undefined) {
            return Object.freeze({ status: 'unavailable', reason: 'scope-disposed' });
        }
        const receipt = this.transport.readRtcCaptureReceipt();
        return Object.freeze(
            receipt ? { status: 'observed', value: receipt } : { status: 'unavailable', reason: 'absent' }
        );
    }

    captureOwnershipFailure(context: ApiMiddleware): 'session-not-current' | 'middleware-not-current' | undefined {
        const session = this.readSession();
        if (session === undefined || toAuthSessionKey(session) !== toAuthSessionKey(context.session)) {
            return 'session-not-current';
        }
        return this.transport.readMiddleware() !== context ? 'middleware-not-current' : undefined;
    }

    private releaseSession(): void {
        for (const listener of [...this.sessionEndListeners]) {
            listener();
        }
        this.deliveries.releaseAll();
    }

    private matches(session: AuthSession): boolean {
        return this.sessionKey === toAuthSessionKey(session);
    }
}
