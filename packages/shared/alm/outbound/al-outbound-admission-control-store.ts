import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    type ALAckPayload,
    type ALNackPayload,
    type ALParsedControlMessage,
    type ALRepairPayload
} from '../../al-contracts/al-control.ts';
import type { ALAdmissionBackend, ALAdmissionWriteContext } from '../al-admission-backend.ts';
import {
    decodeALAdmissionClientRecord,
    decodeALAdmissionControlValue,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import { ALOutboundAdmissionEffectStore } from './al-outbound-admission-effect-store.ts';
import type {
    ALOutboundControlAcceptance,
    ALOutboundPreparedMessageDecoder
} from './al-outbound-admission-store.ts';
import {
    decodeALOutboundPendingAck,
    decodeALOutboundSentMessage
} from './al-outbound-admission-validation.ts';
import {
    computeALOutboundControlAdmission,
    controlTargetMsgId,
    type ALControlAdmissionCandidate,
    type ALControlAdmissionRead,
    type ALControlHistory
} from './compute-al-outbound-control-admission.ts';
import {
    toALOutboundPendingAckExpireAtTimestamp
} from './transition-al-outbound-pending-ack.ts';
import { validateALOutboundControlAdmission } from './validate-al-outbound-control-admission.ts';

export interface CreateALOutboundAdmissionControlStoreInput {
    readonly backend: ALAdmissionBackend;
    readonly effectStore: ALOutboundAdmissionEffectStore;
    readonly namespace: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export class ALOutboundAdmissionControlStore {
    private readonly backend: ALAdmissionBackend;
    private readonly effectStore: ALOutboundAdmissionEffectStore;
    private readonly namespace: string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;

    constructor(input: CreateALOutboundAdmissionControlStoreInput) {
        this.backend = input.backend;
        this.effectStore = input.effectStore;
        this.namespace = input.namespace;
        this.retention = input.retention;
    }

    async acceptControlMessage<TPrepared>(
        msg: ALMessage,
        _decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALOutboundControlAcceptance> {
        const decoded = decodeALControlMessage(msg);
        if (decoded.left) {
            return { handled: false };
        }
        const nowMs = Date.now();
        const read = await this.readControlAdmission(decoded.right!, nowMs);
        const validated = validateALOutboundControlAdmission(
            computeALOutboundControlAdmission(read, this.retention)
        );
        if (validated.left) {
            return { handled: false };
        }
        await this.backend.write(async (tx) => {
            await this.assertControlAdmissionFence(tx, validated.right!.read);
            await this.applyControlAdmission(tx, validated.right!);
        });
        return { handled: true };
    }

    async readAcks(msgId: string): Promise<readonly ALAckPayload[]> {
        return (await this.backend.read(
            this.toHistoryKey('acks', msgId),
            (value) => decodeALAdmissionControlValue(value, msgId, 'acks')
        ))?.values ?? [];
    }

    async readNacks(msgId: string): Promise<readonly ALNackPayload[]> {
        return (await this.backend.read(
            this.toHistoryKey('nacks', msgId),
            (value) => decodeALAdmissionControlValue(value, msgId, 'nacks')
        ))?.values ?? [];
    }

    async readRepairs(msgId: string): Promise<readonly ALRepairPayload[]> {
        return (await this.backend.read(
            this.toHistoryKey('repairs', msgId),
            (value) => decodeALAdmissionControlValue(value, msgId, 'repairs')
        ))?.values ?? [];
    }

    private async readControlAdmission(
        parsed: ALParsedControlMessage,
        nowMs: number
    ): Promise<ALControlAdmissionRead> {
        const targetMsgId = controlTargetMsgId(parsed);
        const owner = await this.backend.read(this.toMessageOwnerKey(targetMsgId), decodeALAdmissionString);
        const ownerVersion = owner
            ? await this.backend.read(this.toVersionKey(owner), (value) => decodeALAdmissionClientRecord(value, owner))
            : undefined;
        const sent = await this.backend.read(
            this.toSentMessageKey(targetMsgId),
            (value) => decodeALOutboundSentMessage(value, targetMsgId)
        );
        const pending = await this.backend.read(
            this.toPendingAckKey(targetMsgId),
            (value) => decodeALOutboundPendingAck(value, targetMsgId)
        );
        const history = await this.readHistory(parsed, targetMsgId);
        return { parsed, targetMsgId, nowMs, owner, ownerVersion, sent, pending, history };
    }

    private async readHistory(
        parsed: ALParsedControlMessage,
        msgId: string
    ): Promise<ALControlHistory> {
        switch (parsed.type) {
            case 'ack':
                return await this.backend.read(
                    this.toHistoryKey('acks', msgId),
                    (value) => decodeALAdmissionControlValue(value, msgId, 'acks')
                ) ?? { kind: 'acks', values: [] };
            case 'nack':
                return await this.backend.read(
                    this.toHistoryKey('nacks', msgId),
                    (value) => decodeALAdmissionControlValue(value, msgId, 'nacks')
                ) ?? { kind: 'nacks', values: [] };
            case 'repair':
                return await this.backend.read(
                    this.toHistoryKey('repairs', msgId),
                    (value) => decodeALAdmissionControlValue(value, msgId, 'repairs')
                ) ?? { kind: 'repairs', values: [] };
        }
    }

    private async assertControlAdmissionFence(
        tx: ALAdmissionWriteContext,
        read: ALControlAdmissionRead
    ): Promise<void> {
        const currentOwner = await tx.read(this.toMessageOwnerKey(read.targetMsgId), decodeALAdmissionString);
        if (currentOwner !== read.owner) {
            throw new ALAdmissionBackendConflictError('Outbound control message owner changed during admission');
        }
        const currentVersion = currentOwner
            ? await tx.read(
                this.toVersionKey(currentOwner),
                (value) => decodeALAdmissionClientRecord(value, currentOwner)
            )
            : undefined;
        if (currentVersion?.version !== read.ownerVersion?.version) {
            throw new ALAdmissionBackendConflictError('Outbound control message version changed during admission');
        }
    }

    private async applyControlAdmission(
        tx: ALAdmissionWriteContext,
        candidate: ALControlAdmissionCandidate
    ): Promise<void> {
        const { read } = candidate;
        await tx.set(
            this.toHistoryKey(candidate.history.kind, read.targetMsgId),
            candidate.history,
            candidate.controlExpireAtTimestamp
        );
        switch (candidate.pending.kind) {
            case 'unchanged':
                break;
            case 'remove':
                await tx.remove(this.toPendingAckKey(read.targetMsgId));
                break;
            case 'set':
                await tx.set(
                    this.toPendingAckKey(read.targetMsgId),
                    candidate.pending.value,
                    toALOutboundPendingAckExpireAtTimestamp(candidate.pending.value)
                );
                break;
        }
        if (candidate.removeRepairAttempt) {
            await tx.remove(this.toRepairAttemptKey(read.targetMsgId));
        }
        if (candidate.repairEffect) {
            await this.effectStore.writePreparedEffect(tx, candidate.repairEffect, candidate.read.nowMs);
        }
        await tx.set(
            this.toVersionKey(read.owner!),
            { senderId: read.owner!, version: (read.ownerVersion?.version ?? 0) + 1 },
            candidate.versionExpireAtTimestamp
        );
    }

    private toHistoryKey(kind: ALControlHistory['kind'], msgId: string): string {
        return `${this.namespace}:control:${kind}:${msgId}`;
    }

    private toMessageOwnerKey(msgId: string): string {
        return `${this.namespace}:msg-owner:${msgId}`;
    }

    private toVersionKey(senderId: string): string {
        return `${this.namespace}:version:${senderId}`;
    }

    private toSentMessageKey(msgId: string): string {
        return `${this.namespace}:sent:${msgId}`;
    }

    private toPendingAckKey(msgId: string): string {
        return `${this.namespace}:pending-ack:${msgId}`;
    }

    private toRepairAttemptKey(msgId: string): string {
        return `${this.namespace}:repair-attempt:${msgId}`;
    }
}
