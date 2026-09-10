import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALAckPayload, ALNackPayload, ALRepairPayload } from '../../../al-contracts/al-control.ts';
import type { ALSupersedenceInput } from '../../../al-contracts/al-runtime.ts';
import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { Key, ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import { ALAdmissionCorruptionError, type ALAdmissionDecoder } from '../../al-admission-decoder.ts';
import {
    decodeALAdmissionClientRecord,
    decodeALAdmissionControlValue,
    decodeALAdmissionString,
    decodeALAdmissionSupersedenceValue
} from '../../al-admission-value-validation.ts';
import type { ALAdmissionReadSession, ALAdmissionWorkBackend } from '../../al-admission-work-backend.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundSentMessageSnapshot
} from '../../al-runtime-state-stores.ts';
import {
    acceptALSupersedenceObservation,
    computeALSupersedenceObservation
} from '../../compute-al-supersedence-observation.ts';
import {
    captureALOutboundCreationExpiry,
    decodeALOutboundCanonicalMessage,
    toALOutboundIdentityKey
} from '../al-outbound-canonical-message.ts';
import { readALOutboundCanonicalMessage } from '../al-outbound-canonical-storage.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';
import { isALOutboundReceiptComplete } from '../transition-al-outbound-pending-ack.ts';
import { validateALOutboundPlannedMessage } from '../validate-al-outbound-dispatch.ts';
import {
    toALOutboundControlHistoryKey,
    toALOutboundOrderingMessageKey,
    toALOutboundPendingAckKey,
    toALOutboundRepairAttemptKey,
    toALOutboundSentMessageKey,
    toALOutboundSupersedenceLatestKey,
    toALOutboundSupersedenceReplacementKey,
    toALOutboundVersionKey
} from './al-outbound-admission-keys.ts';
import type {
    ALOutboundMessageReadDto,
    ALOutboundOutgoingReadInput,
    ALOutboundPlanner,
    ALOutboundRepairReadDto,
    ALOutboundSupersedenceReadState
} from './al-outbound-admission-store.ts';
import {
    applyALOutboundCapturedPolicy,
    decodeALOutboundPendingAck,
    decodeALOutboundRepairAttempt,
    decodeALOutboundSentMessage,
    type ALStoredOutboundMessage
} from './al-outbound-admission-validation.ts';

export type ALOutboundControlHistoryKind = 'acks' | 'nacks' | 'repairs';

export interface CreateALOutboundAdmissionReadsInput {
    readonly nowMs: () => number;
    readonly namespace: string;
    readonly canonicalScope: string;
    readonly backend: ALAdmissionWorkBackend;
    readonly supersedenceTrackTtlMs: number;
}

/**
 * Assembles the decision surface every outbound admission computes on; it never writes. Each chain
 * runs against one caller-owned read session, so a session that is a store snapshot serves the whole
 * surface, and the same chain runs inside an open write when a fence has to re-read it.
 */
export class ALOutboundAdmissionReads<TPrepared> {
    private readOperationCount = 0;
    private readonly nowMs: () => number;
    private readonly namespace: string;
    private readonly canonicalScope: string;
    private readonly backend: ALAdmissionWorkBackend;
    private readonly supersedenceTrackTtlMs: number;

    constructor(input: CreateALOutboundAdmissionReadsInput) {
        this.nowMs = input.nowMs;
        this.namespace = input.namespace;
        this.canonicalScope = input.canonicalScope;
        this.backend = input.backend;
        this.supersedenceTrackTtlMs = input.supersedenceTrackTtlMs;
    }

    /**
     * Admission-store round trips this reader has issued. A commit samples it around its own read
     * chain, so a concurrent read of the same store lands in that window too.
     */
    getReadOperationCount(): number {
        return this.readOperationCount;
    }

    async readOutgoingMessage(
        session: ALAdmissionReadSession,
        input: ALOutboundOutgoingReadInput<TPrepared>
    ): Promise<ALOutboundMessageReadDto<TPrepared>> {
        const { msg, observedCanonicalEntry } = input;
        const nowMs = this.nowMs();
        const [clientRecord, stored, control, repairs] = await Promise.all([
            this.readClientRecord(session, msg.id.senderId),
            this.readStoredMessage(session, msg.id.msgId),
            this.readControlTracking(session, msg.id.msgId),
            this.readRepairs(session, msg.id.msgId)
        ]);
        const { entry: canonicalEntry, message: canonical, creationExpiry } = await readALOutboundCanonicalMessage({
            nowMs: this.nowMs,
            queue: { getItem: (key) => this.readQueueItem(session, key) },
            scope: this.canonicalScope,
            message: msg,
            stored,
            observedEntry: observedCanonicalEntry
        });
        const plan = this.readDispatchPlan(input, canonical, stored);
        const supersedenceInput = toALOutboundSupersedenceInput(msg, plan);
        const supersedence = await this.readSupersedenceState(session, supersedenceInput?.key, msg.id.msgId);

        return {
            kind: 'outgoing',
            storedMessage: stored,
            canonicalScope: this.canonicalScope,
            canonicalEntry,
            creationExpiry: creationExpiry ?? stored?.creationExpiry ?? captureALOutboundCreationExpiry(msg),
            originalMsg: msg,
            msg: plan.msg,
            nowMs,
            clientRecord,
            plan,
            sentSnapshot: stored && canonical && stored.reference.expiresAtMs > this.nowMs()
                ? {
                    msgId: stored.msgId,
                    msg: canonical,
                    outboxKey: stored.reference.key,
                    supersedenceKey: stored.supersedenceKey ?? null
                }
                : undefined,
            ...control,
            repairs,
            supersedence,
            supersedenceAcceptance: supersedenceInput
                ? acceptALSupersedenceObservation({
                    supersedence: supersedenceInput,
                    latest: supersedence.latest,
                    replacement: supersedence.replacement,
                    nowMs,
                    trackTtlMs: this.supersedenceTrackTtlMs
                })
                : undefined
        };
    }

    async readRepairMessage(
        session: ALAdmissionReadSession,
        msgId: string,
        planner: ALOutboundPlanner<TPrepared>
    ): Promise<ALOutboundRepairReadDto<TPrepared>> {
        const owner = await this.readStoredMessage(session, msgId);
        const senderId = owner?.reference.senderId;
        const clientRecord = senderId ? await this.readClientRecord(session, senderId) : undefined;
        // The fenced row is read after the version that fences it, so the two always agree: one
        // session snapshot answers both, and a chain whose snapshot ended re-reads the row rather
        // than pairing a stale one with a version that already counted its delete.
        const stored = senderId ? await this.readStoredMessage(session, msgId) : undefined;
        const sentSnapshot = await this.readCanonicalSentMessage(session, msgId, stored);
        const msg = sentSnapshot?.msg;
        const plan = msg && stored ? applyALOutboundCapturedPolicy(planner(msg), stored.policy) : undefined;
        if (msg && plan) {
            requireALOutboundPlannedMessage(msg, plan.msg);
        }
        return {
            kind: 'repair',
            msgId,
            nowMs: this.nowMs(),
            clientRecord,
            sentSnapshot,
            ...await this.readControlTracking(session, msgId),
            plan
        };
    }

    async isMessageSuperseded(session: ALAdmissionReadSession, msg: ALMessage): Promise<boolean> {
        const tracking = (await this.readStoredMessage(session, msg.id.msgId))?.policy.supersedenceTracking;
        if (!tracking?.enabled || !tracking.key) {
            return false;
        }
        const read = await this.readSupersedenceState(session, tracking.key, msg.id.msgId);
        return computeALSupersedenceObservation({
            supersedence: {
                key: tracking.key,
                msgId: msg.id.msgId,
                replacesMsgId: tracking.replacesMsgId,
                seq: msg.ordering?.seq,
                ts: msg.audit?.createdTs ?? msg.id.ts
            },
            latest: read.latest,
            replacement: read.replacement,
            nowMs: this.nowMs(),
            trackTtlMs: this.supersedenceTrackTtlMs
        }).status === 'superseded';
    }

    /** The admission fact outlives the canonical payload: retention, not the message ttl, ends it. */
    async hasSentMessageAdmission(session: ALAdmissionReadSession, msgId: string): Promise<boolean> {
        const stored = await this.readStoredMessage(session, msgId);
        this.assertSentMessageScope(msgId, stored);
        return stored !== undefined;
    }

    async readSentMessage(
        session: ALAdmissionReadSession,
        msgId: string
    ): Promise<ALOutboundSentMessageSnapshot | undefined> {
        return await this.readCanonicalSentMessage(session, msgId, await this.readStoredMessage(session, msgId));
    }

    async readSentMessageByOrdering(
        session: ALAdmissionReadSession,
        trackKey: string,
        seq: number
    ): Promise<ALOutboundSentMessageSnapshot | undefined> {
        const key = toALOutboundOrderingMessageKey(this.namespace, trackKey, seq);
        const msgId = await this.readValue(session, key, decodeALAdmissionString);
        const sent = msgId ? await this.readSentMessage(session, msgId) : undefined;
        if (sent && (toALOrderingTrackKey(sent.msg) !== trackKey || sent.msg.ordering?.seq !== seq)) {
            throw new ALAdmissionCorruptionError(key, new TypeError('Ordering index differs from canonical message'));
        }
        return sent;
    }

    async readPendingAck(
        session: ALAdmissionReadSession,
        msgId: string
    ): Promise<ALOutboundPendingAckSnapshot | undefined> {
        const receipts = await this.readReceiptState(session, msgId);
        return receipts && !isALOutboundReceiptComplete(receipts) ? receipts : undefined;
    }

    async readReceiptState(
        session: ALAdmissionReadSession,
        msgId: string
    ): Promise<ALOutboundPendingAckSnapshot | undefined> {
        return await this.readValue(
            session,
            toALOutboundPendingAckKey(this.namespace, msgId),
            (value) => decodeALOutboundPendingAck(value, msgId)
        );
    }

    async readAcks(session: ALAdmissionReadSession, msgId: string): Promise<readonly ALAckPayload[]> {
        return (await this.readControlHistory(session, 'acks', msgId))?.values ?? [];
    }

    async readNacks(session: ALAdmissionReadSession, msgId: string): Promise<readonly ALNackPayload[]> {
        return (await this.readControlHistory(session, 'nacks', msgId))?.values ?? [];
    }

    async readRepairs(session: ALAdmissionReadSession, msgId: string): Promise<readonly ALRepairPayload[]> {
        return (await this.readControlHistory(session, 'repairs', msgId))?.values ?? [];
    }

    async readControlHistory<TKind extends ALOutboundControlHistoryKind>(
        session: ALAdmissionReadSession,
        kind: TKind,
        msgId: string
    ) {
        return await this.readValue(
            session,
            toALOutboundControlHistoryKey(this.namespace, kind, msgId),
            (value) => decodeALAdmissionControlValue(value, msgId, kind)
        );
    }

    async readStoredMessage(
        session: ALAdmissionReadSession,
        msgId: string
    ): Promise<ALStoredOutboundMessage | undefined> {
        return await this.readValue(
            session,
            toALOutboundSentMessageKey(this.namespace, msgId),
            (value) => decodeALOutboundSentMessage(value, msgId)
        );
    }

    /** The sender fence, read from a session snapshot or from inside an open admission write. */
    async readClientRecord(session: ALAdmissionReadSession, senderId: string) {
        return await this.readValue(
            session,
            toALOutboundVersionKey(this.namespace, senderId),
            (value) => decodeALAdmissionClientRecord(value, senderId)
        );
    }

    async readSupersedenceState(
        session: ALAdmissionReadSession,
        key: string | undefined,
        msgId: string
    ): Promise<ALOutboundSupersedenceReadState> {
        if (!key) {
            return {};
        }
        const [latest, replacement] = await Promise.all([
            this.readValue(
                session,
                toALOutboundSupersedenceLatestKey(this.namespace, key),
                (value) => decodeALAdmissionSupersedenceValue(value, 'latest')
            ),
            this.readValue(
                session,
                toALOutboundSupersedenceReplacementKey(this.namespace, msgId),
                (value) => decodeALAdmissionSupersedenceValue(value, 'replacement')
            )
        ]);
        return { key, latest, replacement };
    }

    private readDispatchPlan(
        input: ALOutboundOutgoingReadInput<TPrepared>,
        canonical: ALMessage | undefined,
        stored: ALStoredOutboundMessage | undefined
    ): ALOutboundDispatchPlan<TPrepared> {
        const { msg, planner, intent } = input;
        const selected = planner(canonical ?? msg);
        requireALOutboundPlannedMessage(canonical ?? msg, selected.msg);
        const planned = canonical ? { ...selected, msg: canonical } : selected;
        const plan = stored && intent !== 'repair' ? applyALOutboundCapturedPolicy(planned, stored.policy) : planned;
        requireALOutboundPlannedMessage(msg, plan.msg);
        return plan;
    }

    private async readControlTracking(
        session: ALAdmissionReadSession,
        msgId: string
    ): Promise<Pick<ALOutboundRepairReadDto<never>, 'pendingAck' | 'repairAttempt' | 'acks' | 'nacks'>> {
        const [pendingAck, repairAttempt, acks, nacks] = await Promise.all([
            this.readPendingAck(session, msgId),
            this.readValue(
                session,
                toALOutboundRepairAttemptKey(this.namespace, msgId),
                (value) => decodeALOutboundRepairAttempt(value, msgId)
            ),
            this.readAcks(session, msgId),
            this.readNacks(session, msgId)
        ]);
        return { pendingAck, repairAttempt, acks, nacks };
    }

    private async readValue<V>(
        session: ALAdmissionReadSession,
        key: string,
        decode: ALAdmissionDecoder<V>
    ): Promise<V | undefined> {
        this.readOperationCount += 1;
        return await session.read(key, decode);
    }

    private async readQueueItem(
        session: ALAdmissionReadSession,
        key: Key
    ): Promise<ResourceEntry | undefined> {
        this.readOperationCount += 1;
        return await session.readWork(key);
    }

    private assertSentMessageScope(msgId: string, stored: ALStoredOutboundMessage | undefined): void {
        if (stored !== undefined && stored.reference.scope !== this.canonicalScope) {
            throw new ALAdmissionCorruptionError(
                toALOutboundSentMessageKey(this.namespace, msgId),
                new TypeError('Sent message belongs to another local scope')
            );
        }
    }

    private async readCanonicalSentMessage(
        session: ALAdmissionReadSession,
        msgId: string,
        stored: ALStoredOutboundMessage | undefined
    ): Promise<ALOutboundSentMessageSnapshot | undefined> {
        if (!stored || stored.reference.expiresAtMs <= this.nowMs()) {
            return undefined;
        }
        this.assertSentMessageScope(msgId, stored);
        const [canonical, identity] = await Promise.all([
            this.readQueueItem(session, stored.reference.key),
            this.readQueueItem(session, toALOutboundIdentityKey(stored.reference.key))
        ]);
        if (stored.reference.expiresAtMs <= this.nowMs()) {
            return undefined;
        }
        const msg = decodeALOutboundCanonicalMessage(stored.reference, canonical, identity);
        return { msgId, msg, outboxKey: stored.reference.key, supersedenceKey: stored.supersedenceKey ?? null };
    }
}

function requireALOutboundPlannedMessage(source: ALMessage, planned: ALMessage): void {
    const issues = validateALOutboundPlannedMessage(source, planned);
    if (issues.length > 0) {
        throw new NonRetryableException(issues.map((issue) => issue.message).join('; '));
    }
}

export function toALOutboundSupersedenceInput<TPrepared>(
    msg: ALMessage,
    plan: ALOutboundDispatchPlan<TPrepared>
): ALSupersedenceInput | undefined {
    const tracking = plan.supersedenceTracking;
    return tracking?.enabled && tracking.key
        ? {
            key: tracking.key,
            msgId: msg.id.msgId,
            replacesMsgId: tracking.replacesMsgId,
            seq: msg.ordering?.seq,
            ts: msg.audit?.createdTs ?? msg.id.ts
        }
        : undefined;
}
