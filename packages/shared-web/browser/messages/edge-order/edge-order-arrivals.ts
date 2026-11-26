import {
    toEdgeOrderStreamKey,
    type EdgeOrderStreamOrigin
} from '@shared-web/browser/messages/edge-order/edge-order-received-stream.ts';
import type { EdgeOrderReceiverLimits } from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import { EdgeOrderReceiver } from '@shared-web/browser/messages/edge-order/edge-order-receiver.ts';
import { decodeEdgeOrderWirePayload } from '@shared-web/browser/messages/edge-order/edge-order-wire-payload.ts';
import type {
    RallarMessageOrder,
    RallarMessageOrderGap,
    RallarMessagePayload,
    RallarMessageTransport,
    RallarTypedMessageChannelDefinition
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALMessageTrace } from '@shared/al-contracts/trace/to-al-message-trace.ts';
import {
    recordALInboundDiagnostic,
    type ALInboundRuntimeDiagnosticsSink
} from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { computeUtf8ByteLength } from '@shared/encoding/compute-utf8-byte-length.ts';
import { KeyedSerialRuns } from '@shared/resilience/keyed-serial-runs.ts';
import type { Timers } from '@shared/resilience/timers.ts';

type EdgeOrderCarrier = Extract<RallarMessageTransport, 'rtc' | 'ws'>;

/** An arrival that was not handed over at once: held for its turn, or dropped. */
interface UnhandedEdgeOrderArrival {
    readonly carrier: EdgeOrderCarrier;
    readonly message: ALMessage;
    readonly outcome: Exclude<EdgeOrderReceiver.Outcome, 'handed-over'> | 'unwrapped';
    /** Absent exactly for `unwrapped`. */
    readonly order: RallarMessageOrder | undefined;
}

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

    export type GapHandler = NonNullable<RallarTypedMessageChannelDefinition['onOrderGap']>;

    /** What the receive side keeps now, and what it has not handed over since the page loaded. */
    export interface Usage {
        readonly streams: number;
        readonly heldMessages: number;
        readonly evictedStreams: number;
        readonly lateDrops: number;
        readonly gaps: number;
        readonly heldDropped: number;
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
 * turn comes. Everything it holds or does not hand over is stated in the inbound diagnostics, and each gap is given
 * to the handler its channel declared.
 */
export class EdgeOrderArrivals {
    /** By route: the gap handler its latest declaration named; absent when no declaration named one. */
    private readonly declaredRoutes = new Map<string, EdgeOrderArrivals.GapHandler | undefined>();
    private readonly receiver: EdgeOrderReceiver<EdgeOrderArrivals.HandOver>;
    private readonly dependencies: EdgeOrderArrivals.Dependencies;
    /**
     * Per stream, its hand-overs and gap reports in the stream's order: the next starts when the one before it
     * settles, so an async handler finishes a message first, and one stream's turns do not wait for another's.
     */
    private readonly streamRuns = new KeyedSerialRuns<string>();
    /** The runs of positions given up since the page loaded, whatever the reason. */
    private gaps = 0;

    constructor(dependencies: EdgeOrderArrivals.Dependencies) {
        this.dependencies = dependencies;
        this.receiver = new EdgeOrderReceiver(dependencies.limits, {
            timers: {
                nowMs: () => dependencies.timers.nowMs(),
                schedule: (run, delayMs) => dependencies.timers.schedule(() => this.runWake(run), delayMs)
            },
            handOver: (handOver) => {
                const origin = toStreamOrigin(handOver.message, handOver.order.stream);
                this.runInStreamTurn(origin, async () => await this.handOverInTurn(origin, handOver));
            },
            reportGap: (gap) => this.reportGap(gap)
        });
    }

    /**
     * A page declares a channel's topic and type edge-ordered once; every room of that channel is then sorted. The
     * latest gap handler declared for the route stands, as the latest channel for it does.
     */
    declare(route: EdgeOrderArrivals.Route, onOrderGap: EdgeOrderArrivals.GapHandler | undefined): void {
        const routeKey = toRouteKey(route.topicId ?? route.typeId, route.typeId);
        this.declaredRoutes.set(routeKey, onOrderGap ?? this.declaredRoutes.get(routeKey));
    }

    isDeclared(message: ALMessage): boolean {
        return this.declaredRoutes.has(toRouteKey(message.route.topicId, message.payload.typeId));
    }

    /** Settles when the arrival and every message it released have been handed over; at once when it is held. */
    async accept(carrier: EdgeOrderCarrier, message: ALMessage): Promise<void> {
        const wire = decodeEdgeOrderWirePayload(message.payload.resource);
        if (wire === undefined) {
            this.recordArrival({ carrier, message, outcome: 'unwrapped', order: undefined });
            return;
        }
        const order: RallarMessageOrder = { stream: wire.stamp.stream, position: wire.stamp.position };
        const origin = toStreamOrigin(message, order.stream);
        const outcome = this.receiver.accept({
            origin,
            stamp: wire.stamp,
            expiresAtMs: message.constraints?.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
            byteLength: computeUtf8ByteLength(message.payload.resource),
            message: { carrier, message, payload: wire.payload, order }
        });
        if (outcome === 'handed-over') {
            await this.streamRuns.whenIdle(toEdgeOrderStreamKey(origin));
            return;
        }
        this.recordArrival({ carrier, message, outcome, order });
    }

    getUsage(): EdgeOrderArrivals.Usage {
        const counts = this.receiver.getCounts();
        return {
            streams: counts.streams,
            heldMessages: counts.heldMessages,
            evictedStreams: counts.evictedStreams,
            lateDrops: counts.lateMessages,
            gaps: this.gaps,
            heldDropped: counts.droppedMessages
        };
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

    /** States the gap, and gives it to its channel's handler in the stream's turn. */
    private reportGap(gap: RallarMessageOrderGap): void {
        this.recordGap(gap);
        this.runInStreamTurn(gap, async () => await this.notifyGap(gap));
    }

    /**
     * A message's turn in its stream. It waited behind the handlers of the messages before it, so its deadline is
     * judged again here, as the inbound runtime judges a hand-over: past it, the position is a gap.
     */
    private async handOverInTurn(origin: EdgeOrderStreamOrigin, handOver: EdgeOrderArrivals.HandOver): Promise<void> {
        if (!this.isPastDeadline(handOver.message)) {
            await this.dependencies.handOver(handOver);
            return;
        }
        const { position } = handOver.order;
        const gap = {
            ...origin,
            fromPosition: position,
            toPosition: position,
            reason: 'held-message-expired'
        } as const;
        this.recordGap(gap);
        await this.notifyGap(gap);
    }

    /** With the connect gone no clock judges the message: the sorter released it in time, so it is handed over. */
    private isPastDeadline(message: ALMessage): boolean {
        const expiresAtMs = message.constraints?.expiresAtMs;
        if (expiresAtMs === undefined) {
            return false;
        }
        try {
            return expiresAtMs <= this.dependencies.timers.nowMs();
        }
        catch {
            return false;
        }
    }

    /** One stream's hand-overs and gap reports run one at a time, in the order the sorter released them. */
    private runInStreamTurn(origin: EdgeOrderStreamOrigin, turn: () => Promise<void>): void {
        void this.streamRuns.run(toEdgeOrderStreamKey(origin), turn).catch((error) => {
            console.error('Error in a Rallar edge-order hand-over', error);
        });
    }

    private recordGap(gap: RallarMessageOrderGap): void {
        this.gaps += 1;
        recordALInboundDiagnostic(this.dependencies.readInboundDiagnostics(), { kind: 'edge-order-gap', ...gap });
    }

    /** What the application's handler throws, or rejects with, is logged, and the stream goes on. */
    private async notifyGap(gap: RallarMessageOrderGap): Promise<void> {
        try {
            await this.declaredRoutes.get(toRouteKey(gap.topicId, gap.typeId))?.(gap);
        }
        catch (error) {
            console.error('Error notifying Rallar order gap handler', error);
        }
    }

    private recordArrival(arrival: UnhandedEdgeOrderArrival): void {
        const { message, order } = arrival;
        recordALInboundDiagnostic(this.dependencies.readInboundDiagnostics(), {
            kind: 'edge-order-arrival',
            msgId: message.id.msgId,
            typeId: message.payload.typeId,
            senderId: message.id.senderId,
            carrier: arrival.carrier,
            outcome: arrival.outcome,
            stream: order?.stream ?? null,
            position: order?.position ?? null,
            ...toALMessageTrace(message)
        });
    }
}

function toStreamOrigin(message: ALMessage, stream: string): EdgeOrderStreamOrigin {
    return {
        topicId: message.route.topicId,
        typeId: message.payload.typeId,
        senderId: message.id.senderId,
        stream
    };
}

function toRouteKey(topicId: string, typeId: string): string {
    return JSON.stringify([topicId, typeId]);
}
