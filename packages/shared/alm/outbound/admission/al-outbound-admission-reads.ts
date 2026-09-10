import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALAckPayload, ALNackPayload, ALRepairPayload } from '../../../al-contracts/al-control.ts';
import type { ALSupersedenceInput } from '../../../al-contracts/al-runtime.ts';
import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { ALAdmissionCorruptionError } from '../../al-admission-decoder.ts';
import {
    decodeALAdmissionClientRecord,
    decodeALAdmissionControlValue,
    decodeALAdmissionString,
    decodeALAdmissionSupersedenceValue
} from '../../al-admission-value-validation.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../../al-admission-work-backend.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundSentMessageSnapshot
} from '../../al-runtime-state-stores.ts';
import {
    acceptALSupersedenceObservation,
    computeALSupersedenceObservation
} from '../../compute-al-supersedence-observation.ts';
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
import {
    captureALOutboundCreationExpiry,
    decodeALOutboundCanonicalMessage,
    toALOutboundIdentityKey
} from '../al-outbound-canonical-message.ts';
import { readALOutboundCanonicalMessage } from '../al-outbound-canonical-storage.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';
import { isALOutboundReceiptComplete } from '../transition-al-outbound-pending-ack.ts';
import { validateALOutboundPlannedMessage } from '../validate-al-outbound-dispatch.ts';

export type ALOutboundControlHistoryKind = 'acks' | 'nacks' | 'repairs';

export interface CreateALOutboundAdmissionReadsInput {
    readonly nowMs: () => number;
    readonly namespace: string;
    readonly canonicalScope: string;
    readonly backend: ALAdmissionWorkBackend;
    readonly supersedenceTrackTtlMs: number;
}

/** Assembles the decision surface every outbound admission computes on; it never writes. */
export class ALOutboundAdmissionReads<TPrepared> {
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

    async readOutgoingMessage(
        input: ALOutboundOutgoingReadInput<TPrepared>
    ): Promise<ALOutboundMessageReadDto<TPrepared>> {
        const { msg, observedCanonicalEntry } = input;
        const nowMs = this.nowMs();
        const clientRecord = await this.readClientRecord(msg.id.senderId);
        const stored = await this.readStoredMessage(msg.id.msgId);
        const { entry: canonicalEntry, message: canonical, creationExpiry } = await readALOutboundCanonicalMessage({
            nowMs: this.nowMs,
            queue: this.backend.workQueue,
            scope: this.canonicalScope,
            message: msg,
            stored,
            observedEntry: observedCanonicalEntry
        });
        const plan = this.readDispatchPlan(input, canonical, stored);
        const supersedenceInput = toALOutboundSupersedenceInput(msg, plan);
        const supersedence = await this.readSupersedenceState(supersedenceInput?.key, msg.id.msgId);

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
                    supersedenceKey: stored.supersedenceKey
                }
                : undefined,
            ...await this.readControlTracking(msg.id.msgId),
            repairs: await this.readRepairs(msg.id.msgId),
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
        msgId: string,
        planner: ALOutboundPlanner<TPrepared>
    ): Promise<ALOutboundRepairReadDto<TPrepared>> {
        const owner = await this.readStoredMessage(msgId);
        const senderId = owner?.reference.senderId;
        const clientRecord = senderId ? await this.readClientRecord(senderId) : undefined;
        // The fenced row is read after the version that fences it: a delete landing between the two
        // must be visible here rather than pairing a stale snapshot with a version that counted it.
        const stored = senderId ? await this.readStoredMessage(msgId) : undefined;
        const sentSnapshot = await this.readCanonicalSentMessage(msgId, stored);
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
            ...await this.readControlTracking(msgId),
            plan
        };
    }

    async isMessageSuperseded(msg: ALMessage): Promise<boolean> {
        const tracking = (await this.readStoredMessage(msg.id.msgId))?.policy.supersedenceTracking;
        if (!tracking?.enabled || !tracking.key) {
            return false;
        }
        const read = await this.readSupersedenceState(tracking.key, msg.id.msgId);
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

    async readSentMessage(msgId: string): Promise<ALOutboundSentMessageSnapshot | undefined> {
        return await this.readCanonicalSentMessage(msgId, await this.readStoredMessage(msgId));
    }

    async readSentMessageByOrdering(trackKey: string, seq: number): Promise<ALOutboundSentMessageSnapshot | undefined> {
        const key = toALOutboundOrderingMessageKey(this.namespace, trackKey, seq);
        const msgId = await this.backend.read(key, decodeALAdmissionString);
        const sent = msgId ? await this.readSentMessage(msgId) : undefined;
        if (sent && (toALOrderingTrackKey(sent.msg) !== trackKey || sent.msg.ordering?.seq !== seq)) {
            throw new ALAdmissionCorruptionError(key, new TypeError('Ordering index differs from canonical message'));
        }
        return sent;
    }

    async readPendingAck(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined> {
        const receipts = await this.readReceiptState(msgId);
        return receipts && !isALOutboundReceiptComplete(receipts) ? receipts : undefined;
    }

    async readReceiptState(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined> {
        return await this.backend.read(
            toALOutboundPendingAckKey(this.namespace, msgId),
            (value) => decodeALOutboundPendingAck(value, msgId)
        );
    }

    async readAcks(msgId: string): Promise<readonly ALAckPayload[]> {
        return (await this.readControlHistory('acks', msgId))?.values ?? [];
    }

    async readNacks(msgId: string): Promise<readonly ALNackPayload[]> {
        return (await this.readControlHistory('nacks', msgId))?.values ?? [];
    }

    async readRepairs(msgId: string): Promise<readonly ALRepairPayload[]> {
        return (await this.readControlHistory('repairs', msgId))?.values ?? [];
    }

    async readControlHistory<TKind extends ALOutboundControlHistoryKind>(kind: TKind, msgId: string) {
        return await this.backend.read(
            toALOutboundControlHistoryKey(this.namespace, kind, msgId),
            (value) => decodeALAdmissionControlValue(value, msgId, kind)
        );
    }

    async readStoredMessage(msgId: string): Promise<ALStoredOutboundMessage | undefined> {
        return await this.backend.read(
            toALOutboundSentMessageKey(this.namespace, msgId),
            (value) => decodeALOutboundSentMessage(value, msgId)
        );
    }

    async readClientRecord(senderId: string) {
        return await this.backend.read(
            toALOutboundVersionKey(this.namespace, senderId),
            (value) => decodeALAdmissionClientRecord(value, senderId)
        );
    }

    /** The same sender fence, read inside an open admission write. */
    async readClientRecordWithin(tx: ALAdmissionWorkWriteContext, senderId: string) {
        return await tx.read(
            toALOutboundVersionKey(this.namespace, senderId),
            (value) => decodeALAdmissionClientRecord(value, senderId)
        );
    }

    async readSupersedenceState(
        key: string | undefined,
        msgId: string
    ): Promise<ALOutboundSupersedenceReadState> {
        if (!key) {
            return {};
        }
        return {
            key,
            latest: await this.backend.read(
                toALOutboundSupersedenceLatestKey(this.namespace, key),
                (value) => decodeALAdmissionSupersedenceValue(value, 'latest')
            ),
            replacement: await this.backend.read(
                toALOutboundSupersedenceReplacementKey(this.namespace, msgId),
                (value) => decodeALAdmissionSupersedenceValue(value, 'replacement')
            )
        };
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
        msgId: string
    ): Promise<Pick<ALOutboundRepairReadDto<never>, 'pendingAck' | 'repairAttempt' | 'acks' | 'nacks'>> {
        return {
            pendingAck: await this.readPendingAck(msgId),
            repairAttempt: await this.backend.read(
                toALOutboundRepairAttemptKey(this.namespace, msgId),
                (value) => decodeALOutboundRepairAttempt(value, msgId)
            ),
            acks: await this.readAcks(msgId),
            nacks: await this.readNacks(msgId)
        };
    }

    private async readCanonicalSentMessage(
        msgId: string,
        stored: ALStoredOutboundMessage | undefined
    ): Promise<ALOutboundSentMessageSnapshot | undefined> {
        if (!stored || stored.reference.expiresAtMs <= this.nowMs()) {
            return undefined;
        }
        if (stored.reference.scope !== this.canonicalScope) {
            throw new ALAdmissionCorruptionError(
                toALOutboundSentMessageKey(this.namespace, msgId),
                new TypeError('Sent message belongs to another local scope')
            );
        }
        const canonical = await this.backend.workQueue.getItem(stored.reference.key);
        const identity = await this.backend.workQueue.getItem(toALOutboundIdentityKey(stored.reference.key));
        if (stored.reference.expiresAtMs <= this.nowMs()) {
            return undefined;
        }
        const msg = decodeALOutboundCanonicalMessage(stored.reference, canonical, identity);
        return { msgId, msg, outboxKey: stored.reference.key, supersedenceKey: stored.supersedenceKey };
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
