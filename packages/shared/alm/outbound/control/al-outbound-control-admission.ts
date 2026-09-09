import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    type ALParsedControlMessage
} from '../../../al-contracts/al-control.ts';
import { ALAdmissionCorruptionError } from '../../al-admission-decoder.ts';
import { decodeALAdmissionString } from '../../al-admission-value-validation.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../../al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '../../ALAdmissionBackendConflictError.ts';
import { toExpireAtTimestampFromNow, type NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import type { ALWorkOutcome, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import type {
    ALOutboundAdmissionEffectStore,
    ALOutboundEffectCandidate
} from '../al-outbound-admission-effect-store.ts';
import {
    toALOutboundControlHistoryKey,
    toALOutboundMessageOwnerKey,
    toALOutboundNotYetInSyncRetryKey,
    toALOutboundPendingAckKey,
    toALOutboundRepairAttemptKey,
    toALOutboundVersionKey
} from '../al-outbound-admission-keys.ts';
import type { ALOutboundAdmissionReads } from '../al-outbound-admission-reads.ts';
import type {
    ALOutboundDurableEffectWrite,
    ALOutboundNotYetInSyncRetrySchedule,
    ALOutboundNotYetInSyncRetryScheduleResult
} from '../al-outbound-admission-store.ts';
import { decodeALOutboundNotYetInSyncRetry } from '../al-outbound-admission-validation.ts';
import type { ALOutboundMessageRuntime } from '../al-outbound-message-runtime.ts';
import { toALOutboundPendingControlId } from '../al-outbound-pending-admission.ts';
import {
    computeALOutboundWorkEntry,
    isPendingALOutboundWork,
    toALOutboundWorkKey
} from '../al-outbound-work-entry.ts';
import {
    computeALOutboundControlAdmission,
    controlTargetMsgId,
    type ALControlAdmissionCandidate,
    type ALControlAdmissionRead
} from '../compute-al-outbound-control-admission.ts';
import { toALOutboundEffectId } from '../to-al-outbound-effect-id.ts';
import { validateALOutboundControlAdmission } from '../validate-al-outbound-control-admission.ts';

export type ALOutboundControlAdmissionResult =
    | Readonly<{ kind: 'not-handled'; }>
    | Readonly<{ kind: 'committed'; }>
    | Readonly<{ kind: 'pending-control'; }>
    | Readonly<{ kind: 'rejected'; reason: string; }>;

export interface ALOutboundPendingControl {
    readonly kind: 'admit-control';
    readonly msg: ALMessage;
    readonly expiresAtMs: number;
}

export interface CreateALOutboundControlAdmissionInput<TPrepared> {
    readonly clock: ALOutboundMessageRuntime.Clock;
    readonly backend: ALAdmissionWorkBackend;
    readonly effectStore: ALOutboundAdmissionEffectStore<TPrepared>;
    readonly reads: ALOutboundAdmissionReads<TPrepared>;
    readonly namespace: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly port: ALWorkQueuePort;
}

/** One conditional control admission per call; a conflict becomes retained work the outbound worker replays. */
export class ALOutboundControlAdmission<TPrepared> {
    private readonly clock: ALOutboundMessageRuntime.Clock;
    private readonly backend: ALAdmissionWorkBackend;
    private readonly effectStore: ALOutboundAdmissionEffectStore<TPrepared>;
    private readonly reads: ALOutboundAdmissionReads<TPrepared>;
    private readonly namespace: string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly port: ALWorkQueuePort;

    constructor(input: CreateALOutboundControlAdmissionInput<TPrepared>) {
        this.clock = input.clock;
        this.backend = input.backend;
        this.effectStore = input.effectStore;
        this.reads = input.reads;
        this.namespace = input.namespace;
        this.retention = input.retention;
        this.port = input.port;
    }

    async admit(msg: ALMessage): Promise<ALOutboundControlAdmissionResult> {
        const decoded = decodeALControlMessage(msg);
        if (decoded.left) {
            return { kind: 'not-handled' };
        }
        const nowMs = this.clock.nowMs();
        const read = await this.readControlAdmission(decoded.right!, nowMs);
        const computed = computeALOutboundControlAdmission(read, this.retention);
        const issues = validateALOutboundControlAdmission(computed);
        if (issues.length > 0) {
            return { kind: 'rejected', reason: issues.map((issue) => issue.message).join('; ') };
        }
        const effects = this.effectStore.computeEffects(
            await this.effectStore.readEffects(computed.repairEffect ? [computed.repairEffect] : []),
            nowMs
        );
        const workIssues = this.effectStore.validateEffects(effects);
        if (workIssues.length > 0) {
            return { kind: 'rejected', reason: workIssues.map((issue) => issue.message).join('; ') };
        }
        if (await this.writeControlAdmission(computed, effects)) {
            return { kind: 'committed' };
        }
        await this.retainPendingControl(msg, nowMs);
        return { kind: 'pending-control' };
    }

    /** The accepted control and the repair it forwards commit together; a conflict writes nothing. */
    private async writeControlAdmission(
        computed: ALControlAdmissionCandidate,
        effects: readonly ALOutboundEffectCandidate<TPrepared>[]
    ): Promise<boolean> {
        try {
            return await this.backend.write(async (tx) => {
                if (!await this.hasCurrentControlFence(tx, computed.read)) {
                    return false;
                }
                if ((await this.effectStore.validateObservedWork(tx, effects)).length > 0) {
                    return false;
                }
                this.effectStore.writeEffects(tx, effects);
                await this.applyControlAdmission(tx, computed);
                return true;
            });
        }
        catch (error) {
            if (error instanceof ALAdmissionBackendConflictError) {
                return false;
            }
            throw error;
        }
    }

    /** A retained control admission is replayed until it commits or its deadline passes. */
    async replay(payload: ALOutboundPendingControl): Promise<ALWorkOutcome> {
        if (payload.expiresAtMs <= this.clock.nowMs()) {
            return { status: 'completed' };
        }
        const result = await this.admit(payload.msg);
        return { status: result.kind === 'pending-control' ? 'retry' : 'completed' };
    }

    async scheduleNotYetInSyncRetry(
        schedule: ALOutboundNotYetInSyncRetrySchedule
    ): Promise<ALOutboundNotYetInSyncRetryScheduleResult> {
        const nowMs = this.clock.nowMs();
        const pending = await this.readPendingRetry(schedule.msgId);
        if (pending !== undefined) {
            return { status: 'pending', retryAtMs: pending };
        }
        const attempts = (await this.readRetryRecord(schedule.msgId))?.attempts ?? 0;
        if (attempts >= schedule.maxAttempts) {
            return { status: 'exhausted' };
        }
        return await this.commitRetrySchedule(schedule, {
            effectId: toALOutboundEffectId(['nack-retry', schedule.msgId, 'not-yet-in-sync', attempts + 1]),
            retryAtMs: schedule.retryAtMs,
            expireAtTimestamp: schedule.expireAtTimestamp,
            payload: { kind: 'nack-retry', msgId: schedule.msgId, reason: 'not-yet-in-sync' }
        }, attempts + 1);
    }

    private async commitRetrySchedule(
        schedule: ALOutboundNotYetInSyncRetrySchedule,
        effect: ALOutboundDurableEffectWrite<TPrepared>,
        attempts: number
    ): Promise<ALOutboundNotYetInSyncRetryScheduleResult> {
        const nowMs = this.clock.nowMs();
        const candidates = this.effectStore.computeEffects(await this.effectStore.readEffects([effect]), nowMs);
        const issues = this.effectStore.validateEffects(candidates);
        if (issues.length > 0) {
            throw new ALAdmissionCorruptionError(
                effect.effectId,
                new TypeError(issues.map((issue) => issue.message).join('; '))
            );
        }
        const expireAt = schedule.expireAtTimestamp ?? nowMs + this.retention.repairAttemptTtlMs;
        if (expireAt <= this.clock.nowMs()) {
            return { status: 'exhausted' };
        }
        try {
            return await this.backend.write(async (tx) => {
                const versionKey = toALOutboundVersionKey(this.namespace, schedule.senderId);
                const current = await this.reads.readClientRecordWithin(tx, schedule.senderId);
                if (current?.version !== schedule.expectedVersion) {
                    return { status: 'conflict' };
                }
                if ((await this.effectStore.validateObservedWork(tx, candidates)).length > 0) {
                    return { status: 'conflict' };
                }
                if (expireAt <= this.clock.nowMs()) {
                    return { status: 'exhausted' };
                }
                this.effectStore.writeEffects(tx, candidates);
                await tx.set(
                    toALOutboundNotYetInSyncRetryKey(this.namespace, schedule.msgId),
                    { msgId: schedule.msgId, attempts, pendingEffectId: effect.effectId },
                    expireAt
                );
                await tx.set(
                    versionKey,
                    { senderId: schedule.senderId, version: (schedule.expectedVersion ?? 0) + 1 },
                    nowMs + this.retention.versionTtlMs
                );
                return { status: 'scheduled', retryAtMs: schedule.retryAtMs };
            });
        }
        catch (error) {
            if (error instanceof ALAdmissionBackendConflictError) {
                return { status: 'conflict' };
            }
            throw error;
        }
    }

    private async readRetryRecord(msgId: string) {
        return await this.backend.read(
            toALOutboundNotYetInSyncRetryKey(this.namespace, msgId),
            (value) => decodeALOutboundNotYetInSyncRetry(value, msgId)
        );
    }

    /** An already-scheduled retry answers with its own readiness; a stale record schedules again. */
    private async readPendingRetry(msgId: string): Promise<number | undefined> {
        const retry = await this.readRetryRecord(msgId);
        const existing = retry
            ? await this.backend.workQueue.getItem(toALOutboundWorkKey(this.namespace, retry.pendingEffectId))
            : undefined;
        if (existing === undefined || !isPendingALOutboundWork(existing)) {
            return undefined;
        }
        const work = await this.effectStore.readWorkSnapshot(existing);
        if (work.payload.kind !== 'nack-retry' || work.payload.msgId !== msgId) {
            throw new ALAdmissionCorruptionError(
                toALOutboundNotYetInSyncRetryKey(this.namespace, msgId),
                new TypeError('Persisted retry points to another effect')
            );
        }
        return work.retryAtMs;
    }

    private async readControlAdmission(
        parsed: ALParsedControlMessage,
        nowMs: number
    ): Promise<ALControlAdmissionRead> {
        const targetMsgId = controlTargetMsgId(parsed);
        const owner = await this.backend.read(
            toALOutboundMessageOwnerKey(this.namespace, targetMsgId),
            decodeALAdmissionString
        );
        return {
            parsed,
            targetMsgId,
            nowMs,
            owner,
            ownerVersion: owner ? await this.reads.readClientRecord(owner) : undefined,
            sent: await this.reads.readStoredMessage(targetMsgId),
            pending: await this.reads.readReceiptState(targetMsgId),
            history: await this.readControlHistory(parsed, targetMsgId)
        };
    }

    private async readControlHistory(parsed: ALParsedControlMessage, msgId: string) {
        switch (parsed.type) {
            case 'ack':
                return await this.reads.readControlHistory('acks', msgId) ?? { kind: 'acks' as const, values: [] };
            case 'nack':
                return await this.reads.readControlHistory('nacks', msgId) ?? { kind: 'nacks' as const, values: [] };
            case 'repair':
                return await this.reads.readControlHistory('repairs', msgId) ??
                    { kind: 'repairs' as const, values: [] };
        }
    }

    private async hasCurrentControlFence(
        tx: ALAdmissionWorkWriteContext,
        read: ALControlAdmissionRead
    ): Promise<boolean> {
        const currentOwner = await tx.read(
            toALOutboundMessageOwnerKey(this.namespace, read.targetMsgId),
            decodeALAdmissionString
        );
        if (currentOwner !== read.owner) {
            return false;
        }
        const currentVersion = currentOwner
            ? await this.reads.readClientRecordWithin(tx, currentOwner)
            : undefined;
        return currentVersion?.version === read.ownerVersion?.version;
    }

    private async applyControlAdmission(
        tx: ALAdmissionWorkWriteContext,
        candidate: ALControlAdmissionCandidate
    ): Promise<void> {
        const { read } = candidate;
        await tx.set(
            toALOutboundControlHistoryKey(this.namespace, candidate.history.kind, read.targetMsgId),
            candidate.history,
            candidate.controlExpireAtTimestamp
        );
        const pendingAckKey = toALOutboundPendingAckKey(this.namespace, read.targetMsgId);
        if (candidate.pending.kind === 'remove') {
            await tx.remove(pendingAckKey);
        }
        else if (candidate.pending.kind === 'set') {
            await tx.set(pendingAckKey, candidate.pending.value, candidate.receiptExpireAtTimestamp);
        }
        if (candidate.removeRepairAttempt) {
            await tx.remove(toALOutboundRepairAttemptKey(this.namespace, read.targetMsgId));
        }
        await tx.set(
            toALOutboundVersionKey(this.namespace, read.owner!),
            candidate.nextVersion!,
            candidate.versionExpireAtTimestamp
        );
    }

    private async retainPendingControl(msg: ALMessage, nowMs: number): Promise<void> {
        const expiresAtMs = toExpireAtTimestampFromNow(this.retention.durableEffectTtlMs, nowMs);
        await this.port.retainIfAbsent(computeALOutboundWorkEntry({
            namespace: this.namespace,
            effectId: toALOutboundPendingControlId(msg),
            payload: { kind: 'admit-control', msg, expiresAtMs },
            observedAtMs: nowMs,
            retryAtMs: nowMs,
            expireAtTimestamp: expiresAtMs
        }));
    }
}
