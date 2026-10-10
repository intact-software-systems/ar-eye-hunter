import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID } from '../../al-contracts/al-control-type-ids.ts';
import type { ALAckPayload, ALReceiptPayload } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALDeliveryAdmissionVerdict } from '../../alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundEnqueueResult } from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { StateScope } from '../../api/state-types.ts';

export interface WsQueueBoxServerReceiptSocketFacts {
    readonly fromPeerId: string | undefined;
    readonly authenticatedScope: StateScope | undefined;
    readonly scopeDisposition: 'authorized' | 'refused' | 'unobserved';
    readonly scopeAtEpochMs: number | undefined;
}

export interface WsQueueBoxServerReceiptAckFacts {
    readonly controlMsgId: string | undefined;
    readonly controlSenderId: string | undefined;
    readonly controlCreatedAtEpochMs: number | undefined;
    readonly ack: ALAckPayload;
}

export interface WsQueueBoxServerReceiptAggregateFacts {
    readonly msgId: string;
    readonly originPeerId: string;
    readonly expectedRecipientPeerIds: readonly string[];
    readonly confirmedRecipientPeerIds: readonly string[];
    readonly snapshotVersion: number;
    readonly deadlineAtMs: number;
}

export interface WsQueueBoxServerReceiptCountSource {
    readonly source: 'local' | 'relayed' | 'direct';
    readonly relayPublisherId: string | undefined;
    readonly controlMsgId: string | undefined;
    readonly controlSenderId: string | undefined;
    readonly controlCreatedAtEpochMs: number | undefined;
}

export interface WsQueueBoxServerReceiptOutboxVerdict {
    readonly kind: ALDeliveryAdmissionVerdict['kind'];
    readonly durable: boolean | undefined;
    readonly queuedAttempts: number | undefined;
    readonly reason: Extract<ALDeliveryAdmissionVerdict, { readonly reason: string; }>['reason'] | undefined;
    readonly cause: Extract<ALDeliveryAdmissionVerdict, { readonly kind: 'storage-unavailable'; }>['cause'] | undefined;
    readonly limit: Extract<ALDeliveryAdmissionVerdict, { readonly kind: 'refused'; }>['limit'];
}

export type WsQueueBoxServerReceiptObservation =
    | (WsQueueBoxServerReceiptAckFacts & WsQueueBoxServerReceiptSocketFacts & {
        readonly kind: 'socket-decision';
        readonly serverPeerId: string;
        readonly connectionId: string;
        readonly outcome: 'rejected' | ALInboundMessageRuntime.Acceptance['kind'];
        readonly rejectionCode: ALMessageRejection['code'] | undefined;
        readonly handled: boolean | undefined;
    })
    | (WsQueueBoxServerReceiptAckFacts & WsQueueBoxServerReceiptCountSource & {
        readonly kind: 'ack-count';
        readonly serverPeerId: string;
        readonly before: WsQueueBoxServerReceiptAggregateFacts | undefined;
        readonly after: WsQueueBoxServerReceiptAggregateFacts | undefined;
        readonly countAtEpochMs: number;
        readonly outcome: 'rejected' | 'partial' | 'complete';
        readonly rejectionCode: ALMessageRejection['code'] | undefined;
    })
    | (WsQueueBoxServerReceiptAckFacts & {
        readonly kind: 'ack-relay';
        readonly serverPeerId: string;
        readonly outcome: 'provenance-refused' | 'budget-refused' | 'published' | 'publication-failed';
    })
    | {
        readonly kind: 'receipt-outbox';
        readonly serverPeerId: string;
        readonly receiptControlMsgId: string;
        readonly receipt: ALReceiptPayload;
        readonly deadlineAtMs: number;
        readonly verdict: WsQueueBoxServerReceiptOutboxVerdict;
        readonly entryCount: number;
        readonly trackedReceiptAlgo: ALOutboundEnqueueResult['trackedReceiptAlgo'];
    };

/** Private evidence only: one synchronous invocation after the owner's effects; failures never control delivery. */
export type WsQueueBoxServerReceiptObserver = (observation: WsQueueBoxServerReceiptObservation) => void;

export function recordWsQueueBoxServerReceiptObservation(
    observer: WsQueueBoxServerReceiptObserver | undefined,
    observation: WsQueueBoxServerReceiptObservation
): void {
    try {
        observer?.(Object.freeze(observation));
    }
    catch {
        // Producer loss is possible; optional evidence must preserve the owner's result and exception.
    }
}

/** A private projection, never an authorization check; malformed content has no closed ACK observation. */
export function toWsQueueBoxServerReceiptAckFacts(message: ALMessage): WsQueueBoxServerReceiptAckFacts | undefined {
    if (message.payload.typeId !== AL_CONTROL_ACK_TYPE_ID) {
        return undefined;
    }
    try {
        const ack: unknown = JSON.parse(message.payload.resource);
        if (!isClosedAck(ack)) {
            return undefined;
        }
        return Object.freeze({
            controlMsgId: message.id.msgId,
            controlSenderId: message.id.senderId,
            controlCreatedAtEpochMs: message.id.ts,
            ack: toImmutableWsQueueBoxServerReceiptAck(ack)
        });
    }
    catch {
        return undefined;
    }
}

export function toImmutableWsQueueBoxServerReceiptAck(ack: ALAckPayload): ALAckPayload {
    return Object.freeze({
        ackedMsgId: ack.ackedMsgId,
        originPeerId: ack.originPeerId,
        fromPeerId: ack.fromPeerId,
        toPeerId: ack.toPeerId,
        logicalRecipientPeerId: ack.logicalRecipientPeerId,
        carrier: ack.carrier,
        status: ack.status,
        observedAtEpochMs: ack.observedAtEpochMs
    });
}

export function toImmutableWsQueueBoxServerReceiptAggregate(
    aggregate: WsQueueBoxServerReceiptAggregateFacts | undefined
): WsQueueBoxServerReceiptAggregateFacts | undefined {
    return aggregate === undefined ? undefined : Object.freeze({
        msgId: aggregate.msgId,
        originPeerId: aggregate.originPeerId,
        expectedRecipientPeerIds: Object.freeze([...aggregate.expectedRecipientPeerIds]),
        confirmedRecipientPeerIds: Object.freeze([...aggregate.confirmedRecipientPeerIds]),
        snapshotVersion: aggregate.snapshotVersion,
        deadlineAtMs: aggregate.deadlineAtMs
    });
}

export function toWsQueueBoxServerReceiptOutboxVerdict(
    verdict: ALDeliveryAdmissionVerdict
): WsQueueBoxServerReceiptOutboxVerdict {
    return Object.freeze({
        kind: verdict.kind,
        durable: verdict.kind === 'admitted' ? verdict.durable : undefined,
        queuedAttempts: verdict.kind === 'admitted' ? verdict.queuedAttempts : undefined,
        reason: 'reason' in verdict ? verdict.reason : undefined,
        cause: verdict.kind === 'storage-unavailable' ? verdict.cause : undefined,
        limit: verdict.kind === 'refused' ? verdict.limit : undefined
    });
}

function isClosedAck(value: unknown): value is ALAckPayload {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const fields = value as Readonly<Record<string, unknown>>;
    return ['ackedMsgId', 'originPeerId', 'fromPeerId', 'toPeerId', 'logicalRecipientPeerId']
        .every((field) => typeof fields[field] === 'string') &&
        (fields.carrier === 'ws' || fields.carrier === 'rtc') &&
        (fields.status === 'accepted' || fields.status === 'delivered' || fields.status === 'forwarded' ||
            fields.status === 'subtree-complete') &&
        typeof fields.observedAtEpochMs === 'number' && Number.isFinite(fields.observedAtEpochMs);
}
