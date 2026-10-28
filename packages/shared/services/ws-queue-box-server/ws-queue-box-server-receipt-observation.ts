import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID, isALControlTypeId } from '../../al-contracts/al-control-type-ids.ts';
import type { ALAckPayload, ALReceiptPayload } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALDeliveryAdmissionVerdict } from '../../alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundSettledSendResult
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import type {
    ALOutboundReceiptFacts,
    ALOutboundReceiptWorkObservation
} from '../../alm/outbound/lane/al-outbound-receipt-observation.ts';
import type { ALWorkObservationDeferral } from '../../alm/work/al-work-handler.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { WsServerLiveSendResult } from './ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerInboundAuthority } from './ws-queue-box-server-inbound-authority.ts';
import type { WsQueueBoxServerReceiptAggregation } from './ws-queue-box-server-receipt-aggregation.ts';

export type WsQueueBoxServerReceiptAckRejectionObservation =
    & WsQueueBoxServerReceiptAckRejectionIdentity
    & (
        | (WsQueueBoxServerInboundAuthority.CurrentnessRejection & {
            readonly owner: 'inbound-authority';
            readonly connectionId: string;
        })
        | {
            readonly owner: 'receipt-aggregation';
            readonly stage: WsQueueBoxServerReceiptAggregation.ProtocolObservation['stage'];
            readonly failedGuards: readonly [
                WsQueueBoxServerReceiptAggregation.AckGuard,
                ...WsQueueBoxServerReceiptAggregation.AckGuard[]
            ];
            readonly validationAtEpochMs: number;
            readonly deadlineAtMs: number | undefined;
        }
        | {
            readonly owner: 'ack-relay';
            readonly stage: WsQueueBoxServerReceiptAggregation.ProtocolObservation['stage'];
            readonly failedGuards: readonly ['origin-addressee-mismatch'];
        }
    );

export interface WsQueueBoxServerReceiptSocketFacts {
    readonly fromPeerId: string | undefined;
    readonly authenticatedScope: StateScope | undefined;
    readonly scopeDisposition: 'authorized' | 'refused' | 'unobserved';
    readonly scopeAtEpochMs: number | undefined;
}

export interface WsQueueBoxServerReceiptAckFacts {
    readonly controlMsgId: string;
    readonly controlSenderId: string;
    readonly controlCreatedAtEpochMs: number;
    /**
     * The ACK control's own trace, which equals its subject's in production because the ACK is built with it; on
     * `ack-count` the counted aggregate's trace instead, when one is live.
     */
    readonly traceId: string;
    readonly ack: ALAckPayload;
}

export interface WsQueueBoxServerReceiptBusinessFacts {
    readonly msgId: string;
    readonly senderId: string;
    readonly typeId: string;
    readonly topicId: string;
    readonly traceId: string;
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
    readonly source: 'local' | 'relayed';
    readonly relayPublisherId: string | undefined;
}

export interface WsQueueBoxServerReceiptOutboxVerdict {
    readonly kind: ALDeliveryAdmissionVerdict['kind'];
    readonly durable: boolean | undefined;
    readonly queuedAttempts: number | undefined;
    readonly reason: Extract<ALDeliveryAdmissionVerdict, { readonly reason: string; }>['reason'] | undefined;
    readonly cause: Extract<ALDeliveryAdmissionVerdict, { readonly kind: 'storage-unavailable'; }>['cause'] | undefined;
    readonly limit: Extract<ALDeliveryAdmissionVerdict, { readonly kind: 'refused'; }>['limit'];
}

export interface WsQueueBoxServerReceiptTransportObservation extends ALOutboundReceiptFacts {
    readonly kind: 'receipt-transport';
    readonly serverPeerId: string;
    readonly transport: 'recipient' | 'cluster-receipt';
    /** Actual native socket.send invocation/return; neither establishes recipient delivery. */
    readonly nativeCall: 'not-called' | 'invoked' | 'returned';
    readonly connectionId: string | undefined;
    readonly publisherCall: 'absent' | 'invoked' | 'returned';
    readonly originIsHere: boolean | undefined;
    readonly outcome: ALOutboundSettledSendResult['status'] | 'threw';
    readonly submissionAttempted: boolean | undefined;
    readonly retryAfterMs: number | undefined;
}

export interface WsQueueBoxServerReceiptPublicationObservation extends ALOutboundReceiptFacts {
    readonly kind: 'receipt-publication';
    readonly serverPeerId: string;
    readonly publisherId: string;
    readonly publishCall: 'not-called' | 'invoked' | 'returned';
    readonly directCall: 'not-called' | 'invoked' | 'returned';
    readonly outcome: 'returned' | 'threw';
    readonly directStatus: WsServerLiveSendResult['status'] | undefined;
    readonly recipientCount: number | undefined;
    readonly sentCount: number | undefined;
    readonly failedCount: number | undefined;
}

export type WsQueueBoxServerReceiptObservation =
    | WsQueueBoxServerReceiptAckRejectionObservation
    | (ALOutboundReceiptWorkObservation & { readonly serverPeerId: string; })
    | WsQueueBoxServerReceiptTransportObservation
    | WsQueueBoxServerReceiptPublicationObservation
    | (WsQueueBoxServerReceiptBusinessFacts & {
        readonly kind: 'business-socket-decision';
        readonly serverPeerId: string;
        readonly connectionId: string;
        readonly fromPeerId: string | undefined;
        readonly authenticatedScope: StateScope | undefined;
        readonly scopeDisposition: WsQueueBoxServerReceiptSocketFacts['scopeDisposition'];
        readonly outcome: 'rejected' | Exclude<ALInboundMessageRuntime.Acceptance['kind'], 'control'>;
        readonly rejectionCode: ALMessageRejection['code'] | undefined;
    })
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
        /** The issued receipt's trace: its aggregate's subject message's. */
        readonly traceId: string;
        readonly receipt: ALReceiptPayload;
        readonly deadlineAtMs: number;
        readonly verdict: WsQueueBoxServerReceiptOutboxVerdict;
        readonly entryCount: number;
        readonly trackedReceiptAlgo: ALOutboundEnqueueResult['trackedReceiptAlgo'];
    };

/** Private receipt-chain evidence includes ordinary subject ingress after owned effects; failures preserve results. */
export type WsQueueBoxServerReceiptObserver = (observation: WsQueueBoxServerReceiptObservation) => void;

interface WsQueueBoxServerReceiptAckRejectionIdentity {
    readonly kind: 'ack-rejection';
    readonly serverPeerId: string;
    readonly controlMsgId: string;
    readonly controlSenderId: string;
    readonly controlCreatedAtEpochMs: number;
    /** The refused control's own trace; a refusal without a decoded control identity records nothing. */
    readonly traceId: string;
    readonly rejectionCode: 'unauthorized';
}

export function recordWsQueueBoxServerReceiptObservation(
    observer: WsQueueBoxServerReceiptObserver | undefined,
    observation: WsQueueBoxServerReceiptObservation,
    deferObservation?: ALWorkObservationDeferral
): void {
    const immutable = Object.freeze(observation);
    const publish = () => {
        try {
            observer?.(immutable);
        }
        catch { /* Producer loss is possible; optional evidence must preserve the owner's result and exception. */ }
    };
    if (deferObservation === undefined) {
        publish();
    }
    else {
        deferObservation(publish);
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
            traceId: message.id.traceId,
            ack: toImmutableWsQueueBoxServerReceiptAck(ack)
        });
    }
    catch {
        return undefined;
    }
}

/** Closed subject identities only; controls retain their existing observation contracts. */
export function toWsQueueBoxServerReceiptBusinessFacts(
    message: ALMessage
): WsQueueBoxServerReceiptBusinessFacts | undefined {
    return isALControlTypeId(message.payload.typeId) ? undefined : Object.freeze({
        msgId: message.id.msgId,
        senderId: message.id.senderId,
        typeId: message.payload.typeId,
        topicId: message.route.topicId,
        traceId: message.id.traceId
    });
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
