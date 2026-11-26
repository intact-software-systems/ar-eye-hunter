import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    type ALAckPayload,
    type ALNackPayload,
    type ALReceiptPayload
} from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import {
    normalizeALQosPolicy,
    resolveALMessageExpireAtMs,
    resolveALQosNormalizationInput,
    type ALQosInputProvider
} from '../../al-contracts/al-policy.ts';
import { isALUnicastAddressedTo } from '../../al-contracts/is-al-unicast-addressed-to.ts';
import { isALLogicalReceiptMode } from '../../al-contracts/validate-al-ack-support.ts';
import type { ALOutboundPendingAckSnapshot } from '../../alm/al-runtime-state-stores.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundEnqueueResult,
    ALOutboundMessageRuntime
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from '../../alm/outbound/control/read-al-outbound-recipient-proof.ts';
import type { ALReceiptRecordRef } from '../../alm/receipt-record/al-receipt-record-keys.ts';
import type {
    ALReceiptRecordEndedHead,
    ALReceiptRecordOpening
} from '../../alm/receipt-record/al-receipt-record-rows.ts';
import type { ALReceiptRecordStores } from '../../alm/receipt-record/al-receipt-record-stores.ts';
import { ALReceiptRecordWorker } from '../../alm/receipt-record/al-receipt-record-worker.ts';
import { ALReceiptRecord } from '../../alm/receipt-record/al-receipt-record.ts';
import {
    validateALReceiptRecordConfirmation,
    type ALReceiptRecordConfirmationIssue,
    type ALReceiptRecordConfirmationIssueCode
} from '../../alm/receipt-record/validate-al-receipt-record-confirmation.ts';
import {
    validateALReceiptRecordOpening,
    type ALReceiptRecordOpeningIssue
} from '../../alm/receipt-record/validate-al-receipt-record-opening.ts';
import type { Either } from '../../resilience/Either.ts';
import type { InboxOutboxEngine } from '../inbox-outbox-engine.ts';
import {
    resolveWsQueueBoxServerHeadAbsentAck,
    type WsQueueBoxServerHeadAbsentAck
} from './receipt/resolve-ws-queue-box-server-head-absent-ack.ts';
import {
    isWsQueueBoxServerCountableAck,
    toWsQueueBoxServerAckConfirmation,
    toWsQueueBoxServerCountedAck,
    WS_QUEUE_BOX_SERVER_REJECTED_COUNT,
    type WsQueueBoxServerCountedAck
} from './receipt/to-ws-queue-box-server-counted-ack.ts';
import { toWsQueueBoxServerLiveReceiptTransports } from './receipt/to-ws-queue-box-server-live-receipt-transport.ts';
import {
    isWsQueueBoxServerOwnOutsideAudienceNack,
    toWsQueueBoxServerOutsideAudienceConfirmation,
    toWsQueueBoxServerUnrecordedOutsideConfirmations
} from './receipt/to-ws-queue-box-server-outside-audience-confirmation.ts';
import {
    toWsQueueBoxServerOwnReceiptOpening,
    type WsQueueBoxServerOwnPendingReceipt
} from './receipt/to-ws-queue-box-server-own-receipt-opening.ts';
import {
    isWsQueueBoxServerHeadBackedAdmittedReceipt,
    isWsQueueBoxServerReceiptEncodable,
    toWsQueueBoxServerEndedReceiptControlId,
    toWsQueueBoxServerReceiptControlMessage,
    toWsQueueBoxServerReceiptPayload,
    type WsQueueBoxServerIssuedReceipt,
    type WsQueueBoxServerReceiptSets
} from './receipt/to-ws-queue-box-server-receipt-control.ts';
import {
    toWsQueueBoxServerCopyReceiptOpening,
    toWsQueueBoxServerFrozenAudience,
    toWsQueueBoxServerReceiptOpening,
    type WsQueueBoxServerReceiptTerms
} from './receipt/to-ws-queue-box-server-receipt-opening.ts';
import type { WsServerRoomAudience } from './ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerLiveDelivery } from './ws-queue-box-server-live-delivery.ts';
import type { WsQueueBoxServerPreparedMessage } from './ws-queue-box-server-outbound-planning.ts';
import {
    recordWsQueueBoxServerReceiptObservation,
    toImmutableWsQueueBoxServerReceipt,
    toImmutableWsQueueBoxServerReceiptAck,
    toImmutableWsQueueBoxServerReceiptAggregate,
    toWsQueueBoxServerReceiptOutboxVerdict,
    type WsQueueBoxServerReceiptObserver
} from './ws-queue-box-server-receipt-observation.ts';

/** What one `open` answered. */
type WsQueueBoxServerOpenedReceipt = Either<
    ALReceiptRecord.InvalidOpening | ALReceiptRecord.Conflict,
    ALReceiptRecord.View
>;

/** One ACK's count, as its `ack-count` observation states it. */
interface WsQueueBoxServerCountObservationInput {
    readonly control: ALMessage['id'];
    readonly ack: ALAckPayload;
    readonly counted: WsQueueBoxServerCountedAck;
    readonly countAtEpochMs: number;
}

interface WsQueueBoxServerAckRefusal {
    readonly issues: readonly [
        WsQueueBoxServerReceiptAggregation.AckValidationIssue,
        ...WsQueueBoxServerReceiptAggregation.AckValidationIssue[]
    ];
    /** The deadline of the head the refusal read; absent when it read none. */
    readonly deadlineAtMs: number | undefined;
}

/** A confirmation issue of a head still open; extending the ACK issue ties every such record code to a server guard. */
interface WsQueueBoxServerOpenReceiptIssue extends WsQueueBoxServerReceiptAggregation.AckValidationIssue {
    readonly code: Exclude<ALReceiptRecordConfirmationIssueCode, 'head-ended'>;
}

const NO_CONFIRMATIONS: WsQueueBoxServerReceiptSets = {
    confirmedRecipientPeerIds: [],
    outsideAudienceRecipientPeerIds: []
};
const ORIGIN_ADDRESSEE_MISMATCH: WsQueueBoxServerReceiptAggregation.AckValidationIssue = {
    code: 'origin-addressee-mismatch',
    message: 'AL acknowledgement is not addressed to the origin it names'
};
const UNPROVEN_SENDER: WsQueueBoxServerReceiptAggregation.AckValidationIssue = {
    code: 'aggregate-absent',
    message: 'AL acknowledgement names no message its origin admitted to this sender'
};
const ENDED_RECEIPT: WsQueueBoxServerReceiptAggregation.AckValidationIssue = {
    code: 'aggregate-absent',
    message: 'AL acknowledgement names no receipt this server aggregates'
};
/** The server's own refusal to open a receipt it could never answer: no receipt control can carry its largest form. */
const UNENCODABLE_RECEIPT = {
    code: 'receipt-not-encodable',
    message: 'AL receipt control cannot carry the largest receipt of this opening'
} as const;

export namespace WsQueueBoxServerReceiptAggregation {
    export type AckGuard =
        | 'aggregate-absent'
        | 'origin-addressee-mismatch'
        | 'outside-frozen-audience'
        | 'deadline-expired'
        | 'never-sent';

    export interface AckValidationIssue {
        readonly code: AckGuard;
        readonly message: string;
    }

    export interface ProtocolObservation {
        readonly stage: 'ingress-protocol' | 'runtime-protocol';
        /** Absent when no receipt observer is wired. */
        readonly controlIdentity: ALMessage['id'] | undefined;
    }

    export interface Dependencies {
        readonly serverPeerId: string;
        readonly receiptObserver?: WsQueueBoxServerReceiptObserver;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly random: () => number;
        readonly newControlId: () => string;
        readonly qosProvider: ALQosInputProvider | undefined;
        /** The engine the service's queues run on; the record's worker rides it. */
        readonly queueEngine: InboxOutboxEngine;
        readonly recordStores: ALReceiptRecordStores;
        /**
         * The audience the origin's message was admitted under, from the store that admitted it; undefined when no
         * admission of it committed. It proves an ACK that finds no head and is the audience a re-sent copy opens with.
         */
        readonly readIngressAudience: (msgId: string, originPeerId: string) => Promise<readonly string[] | undefined>;
        /**
         * The service's outbound owner admitting one receipt as a durable `WS_OUTBOX` row, so its dequeue reaches the
         * origin through the cluster publisher wherever the origin is connected. An `admitted` receipt with a head
         * behind it goes to the origin's sockets here first, and is a row only when no socket here took it.
         */
        readonly enqueueOutbox: (
            message: ALMessage,
            plan: ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage>
        ) => Promise<ALOutboundEnqueueResult>;
        /** Writes a control to the sockets this instance holds for a peer, with what each native call did. */
        readonly liveDelivery: Pick<WsQueueBoxServerLiveDelivery, 'sendToResolvedPeerWithEvidence'>;
        /** The server's own outbound owner, which answers every control addressed to the server itself. */
        readonly acceptServerControl: (message: ALMessage) => Promise<ALOutboundControlAdmissionResult>;
        /**
         * The server's own outbound owner admitting a terminal receipt into its pending row for the message,
         * as the origin admits it (D38, D48). An outbox-fanned message's row is the one the server's
         * `ack-timeout` retries, so a complete receipt ends its retransmission on every instance.
         */
        readonly acceptServerReceipt: (control: ALMessage) => Promise<ALOutboundControlAdmissionResult>;
        /**
         * The server's pending receipt row of a logically receipted message it sent, with the sent message; undefined
         * for any other message, for a row already complete, and for a message that has ended, whose kept incomplete
         * row it does not return. It proves an ACK that finds no head and an outside-audience NACK, and opens a head
         * its dequeue did not.
         */
        readonly readOwnPendingReceipt: (msgId: string) => Promise<WsQueueBoxServerOwnPendingReceipt | undefined>;
        /**
         * The server's pending receipt row alone, of a logically receipted message it sent; undefined for any other
         * message and for a row already complete. Its outside recipients are the ones a window counts outside.
         */
        readonly readOwnPendingAck: (msgId: string) => Promise<ALOutboundPendingAckSnapshot | undefined>;
    }

    export interface AdmittedMessage {
        readonly message: ALMessage;
        readonly originPeerId: string;
        readonly roomAudience: WsServerRoomAudience | undefined;
        readonly acceptance: ALInboundMessageRuntime.Acceptance | undefined;
        /** Expected recipients this server never sent the message (D708): `[]` at ingress. */
        readonly neverSentRecipientPeerIds: readonly string[];
    }
}

/**
 * The receipts of the `receiver` room messages the server admitted, counted in the receipt record every instance
 * shares and answered to the origin as one durable outbox row per phase. An `admitted` receipt with a head behind it,
 * which a re-sent copy is answered again from, goes to the origin's sockets on this instance first, and is a row only
 * when no socket here took it; every other receipt is always a row. The terminal receipt is written by the
 * record's ended work, on whichever instance claims it, and also settles the server's own pending row for the
 * message. The server's own logically receipted publications are counted in the same record, opened from the
 * server's pending row; their terminal receipt only settles that row, since the server is their origin. It is also
 * the server's control router: a receiver ACK for an origin and an ACK of the server's own publication are counted
 * here, every other control goes to the server's own outbound owner.
 */
export class WsQueueBoxServerReceiptAggregation {
    readonly #dependencies: WsQueueBoxServerReceiptAggregation.Dependencies;
    readonly #record: ALReceiptRecord;
    readonly #worker: ALReceiptRecordWorker;

    constructor(dependencies: WsQueueBoxServerReceiptAggregation.Dependencies) {
        this.#dependencies = dependencies;
        const { recordStores, clock } = dependencies;
        this.#record = new ALReceiptRecord({ ...recordStores, nowMs: () => clock.nowMs() });
        this.#worker = new ALReceiptRecordWorker({
            record: this.#record,
            stores: recordStores,
            workerId: `${dependencies.serverPeerId}:receipt-record`,
            queueEngine: dependencies.queueEngine,
            clock,
            random: dependencies.random,
            writeEndedReceipt: (ended) => this.writeEndedReceipt(ended)
        });
    }

    async dispose(): Promise<void> {
        await this.#worker.dispose();
    }

    /**
     * The typed reason a receiver ACK may not count. Ingress checks only what needs no store; the runtime's check reads
     * the record, and proves an ACK that finds no head against the admission its sender was sent.
     */
    async readRelayedAckRejection(
        ack: ALAckPayload,
        observation: WsQueueBoxServerReceiptAggregation.ProtocolObservation
    ): Promise<ALMessageRejection | undefined> {
        const nowMs = this.#dependencies.clock.nowMs();
        const refusal: WsQueueBoxServerAckRefusal | undefined = ack.toPeerId !== ack.originPeerId
            ? { issues: [ORIGIN_ADDRESSEE_MISMATCH], deadlineAtMs: undefined }
            : observation.stage === 'runtime-protocol'
            ? await this.readRecordRefusal(ack, nowMs)
            : undefined;
        if (refusal === undefined) {
            return undefined;
        }
        this.recordAckRejection(observation, refusal, nowMs);
        return { code: 'unauthorized', message: refusal.issues.map((issue) => issue.message).join('; ') };
    }

    /**
     * A message the server admitted opens its receipt here, once; one it keeps for admission opens none until its
     * replay admits it. A copy its sender sent again that ingress accepts as a duplicate or a pending admission is
     * answered from the record, to that sender alone, so a lost receipt does not leave the sender resending into
     * silence; a copy that finds no head opens the record its admission never opened.
     */
    async writeAdmittedReceipt(admitted: WsQueueBoxServerReceiptAggregation.AdmittedMessage): Promise<void> {
        const { message, originPeerId, neverSentRecipientPeerIds, roomAudience, acceptance } = admitted;
        if (roomAudience === undefined) {
            return;
        }
        const terms = this.resolveReceiptTerms(admitted);
        if (terms === undefined) {
            return;
        }
        if (acceptance?.kind === 'admitted') {
            await this.openAdmittedReceipt(toWsQueueBoxServerReceiptOpening({
                message,
                originPeerId,
                neverSentRecipientPeerIds,
                roomAudience,
                terms,
                nowMs: this.nowMs()
            }));
        }
        else if (acceptance?.kind === 'duplicate' || acceptance?.kind === 'pending-admission') {
            await this.answerCopy(admitted, roomAudience, terms);
        }
    }

    /**
     * A receiver ACK, and the ACK of the server's own publication the record counts, is counted here; one the record
     * does not count, and every other control, goes to the server's own outbound owner. A count whose view is complete
     * is ended; a losing `end` is routine, since the last two ACKs of a message often both read a complete set, and
     * the winner's ended work delivers the receipt.
     */
    async acceptControlMessage(message: ALMessage): Promise<void> {
        const control = decodeALControlMessage(message).right;
        const { serverPeerId } = this.#dependencies;
        if (
            control?.type === 'ack' &&
            (control.payload.toPeerId !== serverPeerId || isWsQueueBoxServerCountableAck(control.payload, serverPeerId))
        ) {
            await this.acceptAck(message, control.payload);
            return;
        }
        await this.#dependencies.acceptServerControl(message);
        if (control?.type === 'nack' && isWsQueueBoxServerOwnOutsideAudienceNack(control.payload, serverPeerId)) {
            await this.writeOutsideAudienceNack(control.payload);
        }
    }

    /**
     * The record's view of the receipt a retry of `message` serves; undefined when the message opened none. At the
     * row's window a server publication heals what its record lost: a head its dequeue did not open opens from its
     * pending row, and an open head counts the outside recipients that row proves.
     */
    async writeRepairView(message: ALMessage): Promise<ALReceiptRecord.View | undefined> {
        const ref = { originPeerId: message.id.senderId, msgId: message.id.msgId };
        const read = await this.#record.read(ref);
        if (ref.originPeerId !== this.#dependencies.serverPeerId) {
            return read.right;
        }
        return read.right === undefined
            ? await this.openOwnRepairView(ref)
            : await this.writeUnrecordedOutside(read.right);
    }

    /**
     * Opens the record of a server publication from its pending row; answers the view it opened, or undefined. An
     * `open` that answers `conflict` (the head exists: a row dequeued again) writes nothing and tells the worker nothing.
     */
    async writeOwnReceiptOpening(own: WsQueueBoxServerOwnPendingReceipt): Promise<ALReceiptRecord.View | undefined> {
        const view = (await this.openOwnReceipt(own))?.right;
        if (view?.tally.complete === true) {
            await this.endReceipt(view.head.opening);
        }
        return view;
    }

    /** Only `end`'s result is authoritative; one that loses to another `end` leaves the winner's work to deliver. */
    async endReceipt(ref: ALReceiptRecordRef): Promise<void> {
        const ended = await this.#record.end(ref);
        if (ended.right !== undefined) {
            this.#worker.committed({ kind: 'ended', ref }, ended.right.endedAtEpochMs);
        }
    }

    private nowMs(): number {
        return this.#dependencies.clock.nowMs();
    }

    /** An `open` that lost to another (`conflict`) answers the head that won; any other refusal opened nothing. */
    private async openOwnRepairView(ref: ALReceiptRecordRef): Promise<ALReceiptRecord.View | undefined> {
        const own = await this.#dependencies.readOwnPendingReceipt(ref.msgId);
        const opened = own === undefined ? undefined : await this.openOwnReceipt(own);
        return opened?.left?.kind === 'conflict' ? (await this.#record.read(ref)).right : opened?.right;
    }

    /** A count that failed after the server's row admitted an outside-audience NACK is written at the next window. */
    private async writeUnrecordedOutside(view: ALReceiptRecord.View): Promise<ALReceiptRecord.View | undefined> {
        if (view.head.phase !== 'open') {
            return view;
        }
        const pending = await this.#dependencies.readOwnPendingAck(view.head.opening.msgId);
        const unrecorded = toWsQueueBoxServerUnrecordedOutsideConfirmations(view, pending);
        if (unrecorded.length === 0) {
            return view;
        }
        for (const confirmation of unrecorded) {
            await this.#record.count(confirmation);
        }
        return (await this.#record.read(view.head.opening)).right;
    }

    private async acceptAck(message: ALMessage, ack: ALAckPayload): Promise<void> {
        const countAtEpochMs = this.nowMs();
        const counted = await this.writeConfirmation(ack);
        if (counted === 'own-not-sent-unproven') {
            return;
        }
        if (counted === 'outbound-owner') {
            await this.#dependencies.acceptServerControl(message);
            return;
        }
        try {
            if (counted.outcome === 'complete') {
                await this.endReceipt(toReceiptRecordRef(ack));
            }
        }
        finally {
            this.recordCountObservation({ control: message.id, ack, counted, countAtEpochMs });
        }
    }

    private async readRecordRefusal(ack: ALAckPayload, nowMs: number): Promise<WsQueueBoxServerAckRefusal | undefined> {
        const head = (await this.#record.read(toReceiptRecordRef(ack))).right?.head;
        if (head === undefined) {
            const audience = await this.#dependencies.readIngressAudience(ack.ackedMsgId, ack.originPeerId);
            return audience?.includes(ack.fromPeerId) === true
                ? undefined
                : { issues: [UNPROVEN_SENDER], deadlineAtMs: undefined };
        }
        const issues = validateALReceiptRecordConfirmation(
            head,
            toWsQueueBoxServerAckConfirmation(ack, this.#dependencies.serverPeerId),
            nowMs
        );
        if (!isOpenReceiptIssueList(issues)) {
            return { issues: [ENDED_RECEIPT], deadlineAtMs: undefined };
        }
        const [first, ...rest] = issues;
        return first === undefined ? undefined : { issues: [first, ...rest], deadlineAtMs: head.opening.deadlineAtMs };
    }

    private recordAckRejection(
        observation: WsQueueBoxServerReceiptAggregation.ProtocolObservation,
        refusal: WsQueueBoxServerAckRefusal,
        nowMs: number
    ): void {
        const { controlIdentity, stage } = observation;
        if (this.#dependencies.receiptObserver === undefined || controlIdentity === undefined) {
            return;
        }
        const [first, ...rest] = refusal.issues.map((issue) => issue.code);
        try {
            recordWsQueueBoxServerReceiptObservation(this.#dependencies.receiptObserver, {
                kind: 'ack-rejection',
                serverPeerId: this.#dependencies.serverPeerId,
                controlMsgId: controlIdentity.msgId,
                controlSenderId: controlIdentity.senderId,
                controlCreatedAtEpochMs: controlIdentity.ts,
                traceId: controlIdentity.traceId,
                rejectionCode: 'unauthorized',
                owner: 'receipt-aggregation',
                stage,
                failedGuards: Object.freeze([first, ...rest] as const),
                validationAtEpochMs: nowMs,
                deadlineAtMs: refusal.deadlineAtMs
            });
        }
        catch { /* Projection failure loses optional evidence, never the already-constructed refusal. */ }
    }

    /** `count` runs first, so an ACK that finds its head reads nothing else; one that finds none is routed. */
    private async writeConfirmation(
        ack: ALAckPayload
    ): Promise<WsQueueBoxServerCountedAck | 'outbound-owner' | 'own-not-sent-unproven'> {
        const { serverPeerId } = this.#dependencies;
        if (!isWsQueueBoxServerCountableAck(ack, serverPeerId)) {
            return WS_QUEUE_BOX_SERVER_REJECTED_COUNT;
        }
        const confirmation = toWsQueueBoxServerAckConfirmation(ack, serverPeerId);
        const counted = await this.#record.count(confirmation);
        if (counted.left?.kind !== 'head-absent') {
            return toWsQueueBoxServerCountedAck(counted);
        }
        const route = resolveWsQueueBoxServerHeadAbsentAck(await this.readHeadAbsentAck(ack));
        if (route === 'count-ahead') {
            return toWsQueueBoxServerCountedAck(await this.#record.countAhead(confirmation));
        }
        return route === 'rejected' ? WS_QUEUE_BOX_SERVER_REJECTED_COUNT : route;
    }

    /** Only an ACK of a server publication reads the server's pending row, its one proof. */
    private async readHeadAbsentAck(ack: ALAckPayload): Promise<WsQueueBoxServerHeadAbsentAck> {
        const { serverPeerId, readOwnPendingReceipt } = this.#dependencies;
        const own = ack.originPeerId === serverPeerId ? await readOwnPendingReceipt(ack.ackedMsgId) : undefined;
        const opening = own === undefined ? undefined : this.toOwnOpening(own);
        return { ack, serverPeerId, own, ownOpeningOpens: opening !== undefined && this.wouldOpen(opening) };
    }

    /** The record's own opening rules and the server's encodability rule, without the warning an attempt writes. */
    private wouldOpen(opening: ALReceiptRecordOpening): boolean {
        return validateALReceiptRecordOpening(opening, this.nowMs()).length === 0 &&
            isWsQueueBoxServerReceiptEncodable(opening, this.#dependencies.serverPeerId);
    }

    /**
     * A recipient that answers a server publication with an outside-audience NACK alone is outside its receipt: the
     * server's pending row naming it outside proves it, whatever this admission answered, and the record, which ends
     * the receipt, counts it outside. An ended message's kept row proves nothing, as for a session's ACK.
     */
    private async writeOutsideAudienceNack(nack: ALNackPayload): Promise<void> {
        const own = await this.#dependencies.readOwnPendingReceipt(nack.msgId);
        if (own?.pending.outsideAudiencePeerIds.includes(nack.logicalRecipientPeerId) !== true) {
            return;
        }
        const confirmation = toWsQueueBoxServerOutsideAudienceConfirmation(nack);
        const counted = await this.#record.count(confirmation);
        const view = toWsQueueBoxServerCountedAck(
            counted.left?.kind === 'head-absent' ? await this.#record.countAhead(confirmation) : counted
        );
        if (view.outcome === 'complete') {
            await this.endReceipt(confirmation);
        }
    }

    private recordCountObservation(input: WsQueueBoxServerCountObservationInput): void {
        if (this.#dependencies.receiptObserver === undefined) {
            return;
        }
        const { control, ack, counted, countAtEpochMs } = input;
        const { view } = counted;
        recordWsQueueBoxServerReceiptObservation(this.#dependencies.receiptObserver, {
            kind: 'ack-count',
            serverPeerId: this.#dependencies.serverPeerId,
            ack: toImmutableWsQueueBoxServerReceiptAck(ack),
            controlMsgId: control.msgId,
            controlSenderId: control.senderId,
            controlCreatedAtEpochMs: control.ts,
            traceId: view?.head.opening.traceId ?? control.traceId,
            after: view === undefined ? undefined : toImmutableWsQueueBoxServerReceiptAggregate({
                ...view.head.opening,
                confirmedRecipientPeerIds: view.tally.confirmedRecipientPeerIds
            }),
            countAtEpochMs,
            outcome: counted.outcome,
            rejectionCode: counted.outcome === 'rejected' ? 'unauthorized' : undefined
        });
    }

    /**
     * A `receiver` room message is aggregated, and a `leader` one as the receipt of its one leader. A message
     * addressed to the server itself is answered by the server's own ACK, never aggregated.
     */
    private resolveReceiptTerms(
        { message, originPeerId }: WsQueueBoxServerReceiptAggregation.AdmittedMessage
    ): WsQueueBoxServerReceiptTerms | undefined {
        const { serverPeerId, qosProvider } = this.#dependencies;
        const qos = resolveALQosNormalizationInput(
            message,
            { selfPeerId: serverPeerId, fromPeerId: originPeerId, direction: 'inbound' },
            qosProvider
        );
        const effective = normalizeALQosPolicy(message, qos).effective;
        return !isALLogicalReceiptMode(effective.ack.algo) || isALUnicastAddressedTo(message, serverPeerId)
            ? undefined
            : {
                ownDeadlineAtMs: resolveALMessageExpireAtMs(message, effective),
                ackTimeoutMs: effective.ack.opts.timeoutMs
            };
    }

    private async openAdmittedReceipt(opening: ALReceiptRecordOpening): Promise<void> {
        if (!this.isEncodable(opening)) {
            return;
        }
        if (opening.expectedRecipientPeerIds.length === 0) {
            await this.writeAnswer(opening, NO_CONFIRMATIONS, 'admitted');
            return;
        }
        const opened = await this.openReceipt(opening);
        if (opened.right !== undefined) {
            await this.answerOpened(opened.right);
        }
    }

    /** Opening writes no `admitted` receipt: the server is the publication's origin, so there is nobody to answer. */
    private async openOwnReceipt(
        own: WsQueueBoxServerOwnPendingReceipt
    ): Promise<WsQueueBoxServerOpenedReceipt | undefined> {
        const opening = this.toOwnOpening(own);
        return opening === undefined || !this.isEncodable(opening) ? undefined : await this.openReceipt(opening);
    }

    private toOwnOpening(own: WsQueueBoxServerOwnPendingReceipt): ALReceiptRecordOpening | undefined {
        return toWsQueueBoxServerOwnReceiptOpening({
            ...own,
            serverPeerId: this.#dependencies.serverPeerId,
            nowMs: this.nowMs()
        });
    }

    /** An opened head's deadline is the worker's; an opening the record refuses is never opened, with one warning. */
    private async openReceipt(opening: ALReceiptRecordOpening): Promise<WsQueueBoxServerOpenedReceipt> {
        const opened = await this.#record.open(opening);
        if (opened.right !== undefined) {
            this.#worker.committed({ kind: 'deadline', ref: opening }, opening.deadlineAtMs);
        }
        else if (opened.left?.kind === 'invalid-opening') {
            writeNotOpenedWarning(opening, opened.left.issues);
        }
        return opened;
    }

    /** An ACK may have overtaken the head, so the admitted receipt carries the view's tally and may end the receipt. */
    private async answerOpened(view: ALReceiptRecord.View): Promise<void> {
        const { opening } = view.head;
        await this.writeAnswer(opening, view.tally, 'admitted');
        if (view.tally.complete) {
            await this.endReceipt(opening);
        }
    }

    private async answerCopy(
        { message, originPeerId, neverSentRecipientPeerIds }: WsQueueBoxServerReceiptAggregation.AdmittedMessage,
        roomAudience: WsServerRoomAudience,
        terms: WsQueueBoxServerReceiptTerms
    ): Promise<void> {
        const ref = { originPeerId, msgId: message.id.msgId };
        const read = await this.#record.read(ref);
        if (read.right !== undefined) {
            await this.answerFromView(read.right);
            return;
        }
        const ingressAudience = await this.#dependencies.readIngressAudience(ref.msgId, ref.originPeerId);
        const opening = toWsQueueBoxServerCopyReceiptOpening({
            message,
            originPeerId,
            neverSentRecipientPeerIds,
            roomAudience,
            ingressAudience,
            terms,
            nowMs: this.nowMs()
        });
        const opened = opening === undefined || !this.isEncodable(opening)
            ? undefined
            : await this.openReceipt(opening);
        if (opened?.right !== undefined) {
            await this.answerOpened(opened.right);
        }
        else if (opened?.left?.kind === 'conflict') {
            const again = await this.#record.read(ref);
            if (again.right !== undefined) {
                await this.answerFromView(again.right);
            }
        }
    }

    /** A receipt no control could carry is never opened, a server publication's as a client's, with one warning. */
    private isEncodable(opening: ALReceiptRecordOpening): boolean {
        if (isWsQueueBoxServerReceiptEncodable(opening, this.#dependencies.serverPeerId)) {
            return true;
        }
        writeNotOpenedWarning(opening, [UNENCODABLE_RECEIPT]);
        return false;
    }

    /** An open head the copy finds complete lost its `end`; the copy ends it, as an opening that finds it complete does. */
    private async answerFromView(view: ALReceiptRecord.View): Promise<void> {
        const { head, tally } = view;
        if (head.phase === 'open') {
            await this.answerOpened(view);
            return;
        }
        await this.writeAnswer(head.opening, tally, head.phase);
    }

    private async writeAnswer(
        opening: ALReceiptRecordOpening,
        { confirmedRecipientPeerIds, outsideAudienceRecipientPeerIds }: WsQueueBoxServerReceiptSets,
        phase: ALReceiptPayload['phase']
    ): Promise<void> {
        await this.writeReceipt({
            receipt: toWsQueueBoxServerReceiptPayload(opening, {
                confirmedRecipientPeerIds,
                outsideAudienceRecipientPeerIds,
                phase,
                observedAtEpochMs: this.nowMs()
            }),
            opening,
            controlId: this.#dependencies.newControlId(),
            settlesServerRow: false
        });
    }

    /**
     * The ended work delivers at least once: one control id per receipt makes each repeat the outbox's duplicate. A
     * receipt of the server's own publication has no origin to reach: it only settles the server's row.
     */
    private async writeEndedReceipt(ended: ALReceiptRecordEndedHead): Promise<void> {
        const issued: WsQueueBoxServerIssuedReceipt = {
            receipt: toWsQueueBoxServerReceiptPayload(ended.opening, {
                ...ended,
                observedAtEpochMs: ended.endedAtEpochMs
            }),
            opening: ended.opening,
            controlId: toWsQueueBoxServerEndedReceiptControlId(ended.opening),
            settlesServerRow: true
        };
        const { serverPeerId } = this.#dependencies;
        if (ended.opening.originPeerId === serverPeerId) {
            await this.admitServerReceipt(toWsQueueBoxServerReceiptControlMessage(issued, serverPeerId));
            return;
        }
        await this.writeReceipt(issued);
    }

    /**
     * A receipt row outlives its message's deadline by the receipt grace, as the origin's receipt row does. A terminal
     * receipt the outbox could not store, or the server's row could not take, throws so the ended work retries it.
     */
    private async writeReceipt(issued: WsQueueBoxServerIssuedReceipt): Promise<void> {
        const { receipt, opening } = issued;
        const { receiptObserver, serverPeerId } = this.#dependencies;
        const message = toWsQueueBoxServerReceiptControlMessage(issued, serverPeerId);
        const enqueued = this.writeLiveReceipt(issued, message)
            ? undefined
            : await this.#dependencies.enqueueOutbox(message, toWsQueueBoxServerReceiptDispatchPlan(message));
        // The enqueue facts are copied before the settlement, which may change the verdict object it returned.
        const observation = receiptObserver === undefined || enqueued === undefined ? undefined : Object.freeze(
            {
                kind: 'receipt-outbox',
                serverPeerId,
                receiptControlMsgId: issued.controlId,
                traceId: opening.traceId,
                receipt: toImmutableWsQueueBoxServerReceipt(receipt),
                deadlineAtMs: opening.deadlineAtMs,
                verdict: toWsQueueBoxServerReceiptOutboxVerdict(enqueued.verdict),
                entryCount: enqueued.entries.length,
                trackedReceiptAlgo: enqueued.trackedReceiptAlgo
            } as const
        );
        try {
            if (issued.settlesServerRow) {
                await this.settleServerRow(message, enqueued);
            }
        }
        finally {
            if (observation !== undefined) {
                recordWsQueueBoxServerReceiptObservation(receiptObserver, observation);
            }
        }
    }

    /**
     * Writes an `admitted` receipt with a head behind it, which a re-sent copy is answered from, to the origin's
     * sockets here, and records one `receipt-transport` per connection it called; whether a socket took it. A sender
     * that resends nothing reads only its terminal receipt when this copy is lost on the wire. Any other receipt is
     * not written here and answers false.
     */
    private writeLiveReceipt(issued: WsQueueBoxServerIssuedReceipt, message: ALMessage): boolean {
        if (!isWsQueueBoxServerHeadBackedAdmittedReceipt(issued.receipt)) {
            return false;
        }
        const { liveDelivery, receiptObserver, serverPeerId } = this.#dependencies;
        const sent = liveDelivery.sendToResolvedPeerWithEvidence({ peerId: issued.receipt.originPeerId, message });
        const transports = receiptObserver === undefined
            ? []
            : toWsQueueBoxServerLiveReceiptTransports(issued, sent.writes, serverPeerId);
        for (const transport of transports) {
            recordWsQueueBoxServerReceiptObservation(receiptObserver, transport);
        }
        return sent.sentCount > 0;
    }

    /**
     * Two commits: a crash between them leaves the server row unsettled until the ended work delivers again. A
     * receipt a socket here took has no enqueue to refuse it.
     */
    private async settleServerRow(message: ALMessage, enqueued: ALOutboundEnqueueResult | undefined): Promise<void> {
        const kind = enqueued?.verdict.kind;
        if (kind === 'storage-unavailable' || kind === 'failed') {
            throw new Error(`AL terminal receipt ${message.id.msgId} was not stored: ${kind}`);
        }
        await this.admitServerReceipt(message);
    }

    /** A terminal receipt the server's row could not take throws, so the ended work retries it. */
    private async admitServerReceipt(message: ALMessage): Promise<void> {
        const settled = await this.#dependencies.acceptServerReceipt(message);
        if (settled.kind === 'storage-unavailable') {
            throw new Error(`AL terminal receipt ${message.id.msgId} did not settle the server row: ${settled.cause}`);
        }
    }
}

/**
 * A kept WS client send its replay admitted, as the admission that starts its receipt; none when its source is
 * not a `ws-client`, when it captured no room audience, or when it carries no snapshot version. The receipt expects
 * the audience the replay's authority answered with, unless that authority left it nobody to expect while the
 * audience captured at ingress had someone: then it expects the captured audience, and records it never sent, since
 * the replay sends it nothing.
 */
export function toWsQueueBoxServerReplayedAdmittedMessage(
    replayed: ALInboundMessageRuntime.ReplayedAdmission
): WsQueueBoxServerReceiptAggregation.AdmittedMessage | undefined {
    const { source, snapshotVersion } = replayed;
    if (source.kind !== 'ws-client' || source.groupRecipientPeerIds === undefined || snapshotVersion === undefined) {
        return undefined;
    }
    const captured = resolveCapturedRecipientPeerIds(replayed, source.groupRecipientPeerIds);
    return {
        message: replayed.msg,
        originPeerId: source.peerId,
        roomAudience: { recipientPeerIds: captured ?? source.groupRecipientPeerIds, snapshotVersion },
        acceptance: { kind: 'admitted' },
        neverSentRecipientPeerIds: captured === undefined
            ? []
            : toWsQueueBoxServerFrozenAudience(replayed.msg, source.peerId, captured)
    };
}

/** The audience captured at ingress, when the replay's own audience leaves nobody to expect and it does not. */
function resolveCapturedRecipientPeerIds(
    { msg, pendingSource }: ALInboundMessageRuntime.ReplayedAdmission,
    replayedRecipientPeerIds: readonly string[]
): readonly string[] | undefined {
    if (pendingSource.kind !== 'ws-client' || pendingSource.groupRecipientPeerIds === undefined) {
        return undefined;
    }
    const { peerId: originPeerId, groupRecipientPeerIds: captured } = pendingSource;
    return toWsQueueBoxServerFrozenAudience(msg, originPeerId, replayedRecipientPeerIds).length === 0 &&
            toWsQueueBoxServerFrozenAudience(msg, originPeerId, captured).length > 0
        ? captured
        : undefined;
}

function isOpenReceiptIssueList(
    issues: readonly ALReceiptRecordConfirmationIssue[]
): issues is readonly WsQueueBoxServerOpenReceiptIssue[] {
    return issues.every(({ code }) => code !== 'head-ended');
}

function writeNotOpenedWarning(
    opening: ALReceiptRecordOpening,
    issues: readonly (ALReceiptRecordOpeningIssue | typeof UNENCODABLE_RECEIPT)[]
): void {
    console.warn(`AL receipt of ${opening.msgId} for ${opening.originPeerId} was not opened`, issues);
}

function toReceiptRecordRef(ack: ALAckPayload): ALReceiptRecordRef {
    return { originPeerId: ack.originPeerId, msgId: ack.ackedMsgId };
}

/**
 * A receipt is a durable outbox row: its immediate phase resolves nobody, and its dequeue reaches the
 * origin's socket on this instance or, through the cluster publisher, on another. The control message
 * itself stays volatile and best-effort, as every control must (`validateControlEnvelope`), so the QoS
 * planner would plan it volatile: the durable plan is built here instead, for the row alone.
 */
function toWsQueueBoxServerReceiptDispatchPlan(
    message: ALMessage
): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
    return {
        msg: message,
        dropReasonCode: undefined,
        lane: 'durable',
        preparedMessages: []
    };
}
