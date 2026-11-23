import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '../../al-contracts/al-contract.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    decodeALControlMessage,
    newALReceiptControlMessage,
    type ALAckPayload,
    type ALReceiptPayload
} from '../../al-contracts/al-control.ts';
import {
    decodePersistedALMessageValue,
    type ALMessageRejection
} from '../../al-contracts/al-message-persistence-validation.ts';
import {
    normalizeALQosPolicy,
    resolveALMessageExpireAtMs,
    resolveALQosNormalizationInput,
    type ALQosInputProvider
} from '../../al-contracts/al-policy.ts';
import { isALUnicastAddressedTo } from '../../al-contracts/is-al-unicast-addressed-to.ts';
import { isALOwnWord } from '../../al-contracts/receipt-proof/al-receipt-proof.ts';
import { isALLogicalReceiptMode } from '../../al-contracts/validate-al-ack-support.ts';
import { isALRecipientConfirmationAck } from '../../alm/delivery/is-al-recipient-confirmation-ack.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import { isALOwnWord } from '../../alm/inbound/control/is-al-same-receipt-statement.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundEnqueueResult,
    ALOutboundMessageRuntime
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from '../../alm/outbound/control/al-outbound-control-admission.ts';
import { toALReceiptRecordRefToken, type ALReceiptRecordRef } from '../../alm/receipt-record/al-receipt-record-keys.ts';
import type {
    ALReceiptRecordEndedHead,
    ALReceiptRecordOpening
} from '../../alm/receipt-record/al-receipt-record-rows.ts';
import type { ALReceiptRecordStores } from '../../alm/receipt-record/al-receipt-record-stores.ts';
import { ALReceiptRecordWorker } from '../../alm/receipt-record/al-receipt-record-worker.ts';
import { ALReceiptRecord } from '../../alm/receipt-record/al-receipt-record.ts';
import type { ALReceiptRecordTally } from '../../alm/receipt-record/compute-al-receipt-record-tally.ts';
import {
    validateALReceiptRecordConfirmation,
    type ALReceiptRecordConfirmationDto,
    type ALReceiptRecordConfirmationIssue,
    type ALReceiptRecordConfirmationIssueCode
} from '../../alm/receipt-record/validate-al-receipt-record-confirmation.ts';
import type { ALReceiptRecordOpeningIssue } from '../../alm/receipt-record/validate-al-receipt-record-opening.ts';
import { fnv1a64 } from '../../queuebox/AppQueueIdentity.ts';
import type { Either } from '../../resilience/Either.ts';
import type { InboxOutboxEngine } from '../inbox-outbox-engine.ts';
import {
    toWsQueueBoxServerCopyReceiptOpening,
    toWsQueueBoxServerFrozenAudience,
    toWsQueueBoxServerReceiptOpening,
    type WsQueueBoxServerReceiptTerms
} from './receipt/to-ws-queue-box-server-receipt-opening.ts';
import type { WsServerRoomAudience } from './ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerPreparedMessage } from './ws-queue-box-server-outbound-planning.ts';
import {
    recordWsQueueBoxServerReceiptObservation,
    toImmutableWsQueueBoxServerReceiptAck,
    toImmutableWsQueueBoxServerReceiptAggregate,
    toWsQueueBoxServerReceiptOutboxVerdict,
    type WsQueueBoxServerReceiptObservation,
    type WsQueueBoxServerReceiptObserver
} from './ws-queue-box-server-receipt-observation.ts';

type WsQueueBoxServerAckCountObservation = Extract<WsQueueBoxServerReceiptObservation, { readonly kind: 'ack-count'; }>;

/** What one count read: its outcome, and the view a counted ACK returned. */
interface WsQueueBoxServerCountedAck {
    readonly outcome: WsQueueBoxServerAckCountObservation['outcome'];
    readonly view: ALReceiptRecord.View | undefined;
}

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

type WsQueueBoxServerReceiptSets = Pick<
    ALReceiptRecordTally,
    'confirmedRecipientPeerIds' | 'outsideAudienceRecipientPeerIds'
>;

/** A receipt's sets at one phase, as observed at one instant. */
interface WsQueueBoxServerReceiptState extends WsQueueBoxServerReceiptSets {
    readonly phase: ALReceiptPayload['phase'];
    readonly observedAtEpochMs: number;
}

/** A receipt the server writes to its outbox; only the ended work's terminal receipt settles the server's own row. */
interface WsQueueBoxServerIssuedReceipt {
    readonly receipt: ALReceiptPayload;
    readonly opening: ALReceiptRecordOpening;
    readonly controlId: string;
    readonly settlesServerRow: boolean;
}

/** A confirmation issue of a head still open; extending the ACK issue ties every such record code to a server guard. */
interface WsQueueBoxServerOpenReceiptIssue extends WsQueueBoxServerReceiptAggregation.AckValidationIssue {
    readonly code: Exclude<ALReceiptRecordConfirmationIssueCode, 'head-ended'>;
}

const COUNT_REJECTED: WsQueueBoxServerCountedAck = { outcome: 'rejected', view: undefined };
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
        | 'sender-recipient-mismatch'
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
         * The service's outbound owner admitting one receipt as a durable `WS_OUTBOX` row, so its
         * dequeue reaches the origin through the cluster publisher wherever the origin is connected.
         */
        readonly enqueueOutbox: (
            message: ALMessage,
            plan: ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage>
        ) => Promise<ALOutboundEnqueueResult>;
        /** The server's own outbound owner, which answers every control addressed to the server itself. */
        readonly acceptServerControl: (message: ALMessage) => Promise<ALOutboundControlAdmissionResult>;
        /**
         * The server's own outbound owner admitting a terminal receipt into its pending row for the message,
         * as the origin admits it (D38, D48). An outbox-fanned message's row is the one the server's
         * `ack-timeout` retries, so a complete receipt ends its retransmission on every instance.
         */
        readonly acceptServerReceipt: (control: ALMessage) => Promise<ALOutboundControlAdmissionResult>;
    }

    export interface AdmittedMessage {
        readonly message: ALMessage;
        readonly originPeerId: string;
        readonly roomAudience: WsServerRoomAudience | undefined;
        readonly acceptance: ALInboundMessageRuntime.Acceptance | undefined;
        /** Expected recipients this server never sent the message (#869, D708): `[]` at ingress. */
        readonly neverSentRecipientPeerIds: readonly string[];
    }
}

/**
 * The receipts of the `receiver` room messages the server admitted, counted in the receipt record every instance
 * shares and answered to the origin as one durable outbox row per phase. The terminal receipt is written by the
 * record's ended work, on whichever instance claims it, and also settles the server's own pending row for the
 * message. It is also the server's control router: a receiver ACK for an origin is counted here, every other control
 * goes to the server's own outbound owner.
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
     * A receiver ACK is counted here and never reaches the server's own outbound owner, which answers only the
     * controls addressed to the server. A count whose view is complete is ended; a losing `end` is routine, since the
     * last two ACKs of a message often both read a complete set, and the winner's ended work delivers the receipt.
     */
    async acceptControlMessage(message: ALMessage): Promise<void> {
        const control = decodeALControlMessage(message).right;
        if (control?.type !== 'ack' || control.payload.toPeerId === this.#dependencies.serverPeerId) {
            await this.#dependencies.acceptServerControl(message);
            return;
        }
        const ack = control.payload;
        const countAtEpochMs = this.nowMs();
        const counted = await this.writeConfirmation(ack);
        try {
            if (counted.outcome === 'complete') {
                await this.endReceipt(toReceiptRecordRef(ack));
            }
        }
        finally {
            this.recordCountObservation({ control: message.id, ack, counted, countAtEpochMs });
        }
    }

    /** The record's view of the receipt a retry of `message` serves; undefined when the message opened none. */
    async readRepairView(message: ALMessage): Promise<ALReceiptRecord.View | undefined> {
        return (await this.#record.read({ originPeerId: message.id.senderId, msgId: message.id.msgId })).right;
    }

    private nowMs(): number {
        return this.#dependencies.clock.nowMs();
    }

    private async readRecordRefusal(ack: ALAckPayload, nowMs: number): Promise<WsQueueBoxServerAckRefusal | undefined> {
        const head = (await this.#record.read(toReceiptRecordRef(ack))).right?.head;
        if (head === undefined) {
            const audience = await this.#dependencies.readIngressAudience(ack.ackedMsgId, ack.originPeerId);
            return audience?.includes(ack.fromPeerId) === true
                ? undefined
                : { issues: [UNPROVEN_SENDER], deadlineAtMs: undefined };
        }
        const issues = validateALReceiptRecordConfirmation(head, this.toConfirmation(ack), nowMs);
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

    /**
     * The server states `not-sent` only from its own path, where it decides it sends a recipient nothing; a frame a
     * session sent never carries the server's peer id as its sender, so no recipient's own word becomes it.
     */
    private toConfirmation(ack: ALAckPayload): ALReceiptRecordConfirmationDto {
        const kind = this.isServerNotSentAck(ack)
            ? 'not-sent'
            : isALRecipientConfirmationAck(ack)
            ? 'confirmed'
            : 'outside';
        return { ...toReceiptRecordRef(ack), recipientPeerId: ack.logicalRecipientPeerId, kind };
    }

    /** The server speaks for a recipient only to say it sent that recipient nothing, which confirms nobody. */
    private isServerNotSentAck(ack: ALAckPayload): boolean {
        return ack.fromPeerId === this.#dependencies.serverPeerId && !isALRecipientConfirmationAck(ack);
    }

    /**
     * The ingress hook proved the sender of an ACK that finds no head against its origin's admission, so such an ACK
     * is counted ahead of its head without a second proof; the server's own `not-sent` needs none.
     */
    private async writeConfirmation(ack: ALAckPayload): Promise<WsQueueBoxServerCountedAck> {
        if (ack.toPeerId !== ack.originPeerId || !(isALOwnWord(ack) || this.isServerNotSentAck(ack))) {
            return COUNT_REJECTED;
        }
        const confirmation = this.toConfirmation(ack);
        const counted = await this.#record.count(confirmation);
        return toCountedAck(
            counted.left?.kind === 'head-absent' ? await this.#record.countAhead(confirmation) : counted
        );
    }

    /** Only `end`'s result is authoritative; one that loses to another `end` leaves the winner's work to deliver. */
    private async endReceipt(ref: ALReceiptRecordRef): Promise<void> {
        const ended = await this.#record.end(ref);
        if (ended.right !== undefined) {
            this.#worker.committed({ kind: 'ended', ref }, ended.right.endedAtEpochMs);
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
        const opened = await this.#record.open(opening);
        if (opened.right !== undefined) {
            await this.answerOpened(opened.right);
        }
        else if (opened.left?.kind === 'invalid-opening') {
            writeNotOpenedWarning(opening, opened.left.issues);
        }
    }

    /** An ACK may have overtaken the head, so the admitted receipt carries the view's tally and may end the receipt. */
    private async answerOpened(view: ALReceiptRecord.View): Promise<void> {
        const { opening } = view.head;
        this.#worker.committed({ kind: 'deadline', ref: opening }, opening.deadlineAtMs);
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
            : await this.#record.open(opening);
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

    /** Decision 9 for the server's own rule: a receipt no control could carry is never opened, with one warning. */
    private isEncodable(opening: ALReceiptRecordOpening): boolean {
        if (isWsQueueBoxServerReceiptEncodable(opening, this.#dependencies.serverPeerId)) {
            return true;
        }
        writeNotOpenedWarning(opening, [UNENCODABLE_RECEIPT]);
        return false;
    }

    private async answerFromView({ head, tally }: ALReceiptRecord.View): Promise<void> {
        await this.writeAnswer(head.opening, tally, head.phase === 'open' ? 'admitted' : head.phase);
    }

    private async writeAnswer(
        opening: ALReceiptRecordOpening,
        { confirmedRecipientPeerIds, outsideAudienceRecipientPeerIds }: WsQueueBoxServerReceiptSets,
        phase: ALReceiptPayload['phase']
    ): Promise<void> {
        await this.writeReceipt({
            receipt: toReceiptPayload(opening, {
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

    /** The ended work delivers at least once: one control id per receipt makes each repeat the outbox's duplicate. */
    private async writeEndedReceipt(ended: ALReceiptRecordEndedHead): Promise<void> {
        await this.writeReceipt({
            receipt: toReceiptPayload(ended.opening, { ...ended, observedAtEpochMs: ended.endedAtEpochMs }),
            opening: ended.opening,
            controlId: toWsQueueBoxServerEndedReceiptControlId(ended.opening),
            settlesServerRow: true
        });
    }

    /**
     * A receipt row outlives its message's deadline by the receipt grace, as the origin's receipt row does. A terminal
     * receipt the outbox could not store, or the server's row could not take, throws so the ended work retries it.
     */
    private async writeReceipt(issued: WsQueueBoxServerIssuedReceipt): Promise<void> {
        const { receipt, opening } = issued;
        const message = toReceiptControlMessage(issued, this.#dependencies.serverPeerId);
        const { receiptObserver, serverPeerId } = this.#dependencies;
        const enqueued = await this.#dependencies.enqueueOutbox(
            message,
            toWsQueueBoxServerReceiptDispatchPlan(message)
        );
        // The enqueue facts are copied before the settlement, which may change the verdict object it returned.
        const observation = receiptObserver === undefined ? undefined : Object.freeze(
            {
                kind: 'receipt-outbox',
                serverPeerId,
                receiptControlMsgId: issued.controlId,
                traceId: opening.traceId,
                receipt: Object.freeze({
                    ...receipt,
                    expectedRecipientPeerIds: Object.freeze([...receipt.expectedRecipientPeerIds]),
                    confirmedRecipientPeerIds: Object.freeze([...receipt.confirmedRecipientPeerIds]),
                    outsideAudienceRecipientPeerIds: Object.freeze([...receipt.outsideAudienceRecipientPeerIds])
                }),
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

    /** Two commits: a crash between them leaves the server row unsettled until the ended work delivers again. */
    private async settleServerRow(message: ALMessage, enqueued: ALOutboundEnqueueResult): Promise<void> {
        const { kind } = enqueued.verdict;
        if (kind === 'storage-unavailable' || kind === 'failed') {
            throw new Error(`AL terminal receipt ${message.id.msgId} was not stored: ${kind}`);
        }
        const settled = await this.#dependencies.acceptServerReceipt(message);
        if (settled.kind === 'storage-unavailable') {
            throw new Error(`AL terminal receipt ${message.id.msgId} did not settle the server row: ${settled.cause}`);
        }
    }
}

/** The control id of the terminal receipt the ended work of `ref` delivers, however often it delivers it. */
export function toWsQueueBoxServerEndedReceiptControlId(ref: ALReceiptRecordRef): string {
    return `al-receipt-ended:${fnv1a64(toALReceiptRecordRefToken(ref))}`;
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

function toCountedAck(
    counted: Either<
        ALReceiptRecord.HeadAbsent | ALReceiptRecord.InvalidConfirmation | ALReceiptRecord.Conflict,
        ALReceiptRecord.CountedAhead
    >
): WsQueueBoxServerCountedAck {
    return counted.fold<WsQueueBoxServerCountedAck>(
        (refusal) => refusal.kind === 'conflict' ? { outcome: 'conflict', view: undefined } : COUNT_REJECTED,
        (written) => {
            if (!('view' in written)) {
                return { outcome: 'partial', view: undefined };
            }
            const { head, tally } = written.view;
            return { outcome: head.phase === 'open' && tally.complete ? 'complete' : 'partial', view: written.view };
        }
    );
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

/**
 * Whether the control's own codec carries the largest receipt this opening can need. That is a `timed-out` receipt
 * naming every expected recipient outside: a terminal receipt lists each recipient once across its two sets, both
 * keys are always written, one list costs one comma more than a split, and only `timed-out`, one character longer than
 * `complete`, can name every recipient without a confirmation. It is built by the same function as every receipt.
 */
function isWsQueueBoxServerReceiptEncodable(opening: ALReceiptRecordOpening, serverPeerId: string): boolean {
    const largest: WsQueueBoxServerIssuedReceipt = {
        receipt: toReceiptPayload(opening, {
            confirmedRecipientPeerIds: [],
            outsideAudienceRecipientPeerIds: opening.expectedRecipientPeerIds,
            phase: 'timed-out',
            observedAtEpochMs: opening.deadlineAtMs
        }),
        opening,
        controlId: toWsQueueBoxServerEndedReceiptControlId(opening),
        settlesServerRow: true
    };
    try {
        toReceiptControlMessage(largest, serverPeerId);
        return true;
    }
    catch (error) {
        // The receipt control's codec offers no typed refusal: it refuses by throwing `TypeError`, and only that.
        if (error instanceof TypeError) {
            return false;
        }
        throw error;
    }
}

function toReceiptControlMessage(
    { receipt, opening, controlId }: WsQueueBoxServerIssuedReceipt,
    serverPeerId: string
): ALMessage {
    const id = {
        v: AL_MESSAGE_ENVELOPE_VERSION,
        msgId: controlId,
        senderId: serverPeerId,
        ts: receipt.observedAtEpochMs,
        traceId: opening.traceId
    };
    return decodePersistedALMessageValue({
        ...newALReceiptControlMessage(id, receipt),
        constraints: {
            expiresAtMs: Math.max(opening.deadlineAtMs, receipt.observedAtEpochMs) + AL_RECEIPT_DEADLINE_GRACE_MS
        }
    });
}

function toReceiptPayload(opening: ALReceiptRecordOpening, state: WsQueueBoxServerReceiptState): ALReceiptPayload {
    return {
        msgId: opening.msgId,
        originPeerId: opening.originPeerId,
        expectedRecipientPeerIds: opening.expectedRecipientPeerIds,
        confirmedRecipientPeerIds: state.confirmedRecipientPeerIds,
        outsideAudienceRecipientPeerIds: state.outsideAudienceRecipientPeerIds,
        snapshotVersion: opening.snapshotVersion,
        phase: state.phase,
        observedAtEpochMs: state.observedAtEpochMs
    };
}
