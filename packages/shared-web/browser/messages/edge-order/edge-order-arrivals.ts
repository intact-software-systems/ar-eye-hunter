import type { EdgeOrderGap } from '@shared-web/browser/messages/edge-order/edge-order-gap.ts';
import type { EdgeOrderReceiverLimits } from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import { EdgeOrderReceiver } from '@shared-web/browser/messages/edge-order/edge-order-receiver.ts';
import { decodeEdgeOrderWirePayload } from '@shared-web/browser/messages/edge-order/edge-order-wire-payload.ts';
import type {
    RallarMessageOrder,
    RallarMessagePayload,
    RallarMessageTransport
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALMessageTrace } from '@shared/al-contracts/trace/to-al-message-trace.ts';
import {
    recordALInboundDiagnostic,
    type ALInboundRuntimeDiagnosticsSink
} from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { computeUtf8ByteLength } from '@shared/encoding/compute-utf8-byte-length.ts';
import type { Timers } from '@shared/resilience/timers.ts';

type EdgeOrderCarrier = Extract<RallarMessageTransport, 'rtc' | 'ws'>;

export namespace EdgeOrderArrivals {
    /** A message whose turn has come: the envelope as it arrived, the application's payload and its place. */
    export interface HandOver {
        readonly carrier: EdgeOrderCarrier;
        readonly message: ALMessage;
        readonly payload: RallarMessagePayload;
        readonly order: RallarMessageOrder;
    }

    export interface Route {
        readonly topicId: string | undefined;
        readonly typeId: string;
    }

    export interface Dependencies {
        readonly limits: EdgeOrderReceiverLimits;
        /**
         * The clock is the connect's server clock, the one the inbound runtime judges a hand-over deadline by, and
         * it throws once that connect is gone. Its timers are the page's.
         */
        readonly timers: Timers;
        readInboundDiagnostics(): ALInboundRuntimeDiagnosticsSink;
        /** Runs the handlers of the carrier the message came over. Never rejects. */
        handOver(handOver: HandOver): Promise<void>;
    }
}

/**
 * The receive side of the page's edge-ordered channels. One sorter serves both carriers, because one sender's
 * stream can arrive over both: each arrival is unwrapped, put in its stream's order, and handed over when its
 * turn comes, one message at a time. Everything it does not hand over is stated in the inbound diagnostics.
 */
export class EdgeOrderArrivals {
    private readonly declaredRoutes = new Set<string>();
    private readonly receiver: EdgeOrderReceiver<EdgeOrderArrivals.HandOver>;
    private readonly dependencies: EdgeOrderArrivals.Dependencies;
    /** Every hand-over so far: the next one starts when it settles, so an async handler finishes a message first. */
    private handedOver: Promise<void> = Promise.resolve();

    constructor(dependencies: EdgeOrderArrivals.Dependencies) {
        this.dependencies = dependencies;
        this.receiver = new EdgeOrderReceiver(dependencies.limits, {
            timers: {
                nowMs: () => dependencies.timers.nowMs(),
                schedule: (run, delayMs) => dependencies.timers.schedule(() => this.runWake(run), delayMs)
            },
            handOver: (handOver) => {
                this.handedOver = this.handedOver.then(() => dependencies.handOver(handOver));
            },
            reportGap: (gap) => this.recordGap(gap)
        });
    }

    /** A page declares a channel's topic and type edge-ordered once; every room of that channel is then sorted. */
    declare(route: EdgeOrderArrivals.Route): void {
        this.declaredRoutes.add(toRouteKey(route.topicId ?? route.typeId, route.typeId));
    }

    isDeclared(message: ALMessage): boolean {
        return this.declaredRoutes.has(toRouteKey(message.route.topicId, message.payload.typeId));
    }

    /** Settles when the arrival and every message it released have been handed over; at once when it is held. */
    async accept(carrier: EdgeOrderCarrier, message: ALMessage): Promise<void> {
        const wire = decodeEdgeOrderWirePayload(message.payload.resource);
        if (wire === undefined) {
            this.recordDrop(carrier, message, 'unwrapped', undefined);
            return;
        }
        const order: RallarMessageOrder = { stream: wire.stamp.stream, position: wire.stamp.position };
        const outcome = this.receiver.accept({
            senderId: message.id.senderId,
            stamp: wire.stamp,
            expiresAtMs: message.constraints?.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
            byteLength: computeUtf8ByteLength(message.payload.resource),
            message: { carrier, message, payload: wire.payload, order }
        });
        if (outcome === 'handed-over') {
            await this.handedOver;
        }
        else if (outcome !== 'held') {
            this.recordDrop(carrier, message, outcome, order);
        }
    }

    /** The connect is gone, and with it the clock every held message was judged by. */
    dropHeldMessages(): void {
        const count = this.receiver.dropHeldMessages();
        if (count > 0) {
            recordALInboundDiagnostic(this.dependencies.readInboundDiagnostics(), {
                kind: 'edge-order-held-dropped',
                count
            });
        }
    }

    /** A wake that cannot read the clock has outlived its connect. */
    private runWake(run: () => void | Promise<void>): void {
        try {
            void run();
        }
        catch {
            this.dropHeldMessages();
        }
    }

    private recordGap(gap: EdgeOrderGap): void {
        recordALInboundDiagnostic(this.dependencies.readInboundDiagnostics(), { kind: 'edge-order-gap', ...gap });
    }

    private recordDrop(
        carrier: EdgeOrderCarrier,
        message: ALMessage,
        cause: 'unwrapped' | 'late' | 'duplicate' | 'expired',
        order: RallarMessageOrder | undefined
    ): void {
        recordALInboundDiagnostic(this.dependencies.readInboundDiagnostics(), {
            kind: 'edge-order-drop',
            msgId: message.id.msgId,
            typeId: message.payload.typeId,
            senderId: message.id.senderId,
            carrier,
            cause,
            stream: order?.stream ?? null,
            position: order?.position ?? null,
            ...toALMessageTrace(message)
        });
    }
}

function toRouteKey(topicId: string, typeId: string): string {
    return JSON.stringify([topicId, typeId]);
}
