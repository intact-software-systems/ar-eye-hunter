import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALNackPayload,
    ALRepairPayload
} from '../../al-contracts/al-control.ts';
import { parseALControlMessage } from '../../al-contracts/al-control.ts';
import type { ALAdmissionBackend, ALAdmissionWriteContext } from '../al-admission-backend.ts';
import {
    decodeALAdmissionClientRecord,
    decodeALAdmissionControlValue,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';
import { toExpireAtTimestampFromNow, type NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import { ALOutboundAdmissionEffectStore } from './al-outbound-admission-effect-store.ts';
import type {
    ALOutboundControlAcceptance,
    ALOutboundDurableEffectWrite,
    ALOutboundPreparedMessageDecoder,
    ALOutboundRepairHint
} from './al-outbound-admission-store.ts';
import { decodeALOutboundPendingAck } from './al-outbound-admission-validation.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import {
    acceptALOutboundPendingAckSnapshot,
    appendUniqueALAck,
    toALOutboundPendingAckExpireAtTimestamp
} from './transition-al-outbound-pending-ack.ts';

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
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALOutboundControlAcceptance> {
        const parsed = parseALControlMessage(msg);
        if (!parsed) {
            return { handled: false };
        }

        return await this.backend.write(async (tx) => {
            switch (parsed.type) {
                case 'ack':
                    await this.acceptAck(tx, parsed.payload, Date.now());
                    break;
                case 'nack':
                    await this.acceptNack(tx, parsed.payload, decodePrepared);
                    break;
                case 'repair':
                    await this.acceptRepair(tx, parsed.payload, decodePrepared);
                    break;
            }
            return { handled: true };
        });
    }

    async readAcks(msgId: string): Promise<readonly ALAckPayload[]> {
        return (await this.backend.read(
            this.toAcksKey(msgId),
            (value) => decodeALAdmissionControlValue(value, msgId, 'acks')
        ))?.values ?? [];
    }

    async readNacks(msgId: string): Promise<readonly ALNackPayload[]> {
        return (await this.backend.read(
            this.toNacksKey(msgId),
            (value) => decodeALAdmissionControlValue(value, msgId, 'nacks')
        ))?.values ?? [];
    }

    async readRepairs(msgId: string): Promise<readonly ALRepairPayload[]> {
        return (await this.backend.read(
            this.toRepairsKey(msgId),
            (value) => decodeALAdmissionControlValue(value, msgId, 'repairs')
        ))?.values ?? [];
    }

    private async acceptAck(tx: ALAdmissionWriteContext, ack: ALAckPayload, nowMs: number): Promise<void> {
        const nextAcks = appendUniqueALAck({
            current: (await tx.read(this.toAcksKey(ack.ackedMsgId), (value) =>
                decodeALAdmissionControlValue(value, ack.ackedMsgId, 'acks')))?.values ?? [],
            next: ack
        });
        const current = await tx.read(
            this.toPendingAckKey(ack.ackedMsgId),
            (value) => decodeALOutboundPendingAck(value, ack.ackedMsgId)
        );
        const pending = acceptALOutboundPendingAckSnapshot({ current, acks: nextAcks, ack });
        await tx.set(this.toAcksKey(ack.ackedMsgId), { kind: 'acks', values: nextAcks }, this.controlExpireAt(nowMs));
        if (pending) {
            await tx.set(
                this.toPendingAckKey(ack.ackedMsgId),
                pending,
                toALOutboundPendingAckExpireAtTimestamp(pending)
            );
        }
        else if (current) {
            await tx.remove(this.toPendingAckKey(ack.ackedMsgId));
            await tx.remove(this.toRepairAttemptKey(ack.ackedMsgId));
        }
        await this.bumpOwnerVersion(tx, ack.ackedMsgId);
    }

    private async acceptNack<TPrepared>(
        tx: ALAdmissionWriteContext,
        nack: ALNackPayload,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<void> {
        const nowMs = Date.now();
        const prior = await tx.read(
            this.toNacksKey(nack.msgId),
            (value) => decodeALAdmissionControlValue(value, nack.msgId, 'nacks')
        );
        const nextNacks = [...(prior?.values ?? []), nack];
        await tx.set(this.toNacksKey(nack.msgId), { kind: 'nacks', values: nextNacks }, this.controlExpireAt(nowMs));
        if (nack.reason === 'expired' || nack.reason === 'unauthorized' || nack.reason === 'stale') {
            await tx.remove(this.toPendingAckKey(nack.msgId));
            await tx.remove(this.toRepairAttemptKey(nack.msgId));
        }
        else if (nack.reason === 'gap') {
            await this.effectStore.persistEffect(
                tx,
                this.toRepairHintEffectWrite<TPrepared>(nack.msgId, {
                    trigger: 'nack',
                    requestedByPeerId: nack.fromPeerId,
                    orderingTrackKey: nack.orderingKey,
                    missingSeqs: nack.missingSeqs ?? [],
                    failedPeerIds: []
                }, nack.observedAtEpochMs),
                decodePrepared
            );
        }
        await this.bumpOwnerVersion(tx, nack.msgId);
    }

    private async acceptRepair<TPrepared>(
        tx: ALAdmissionWriteContext,
        repair: ALRepairPayload,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<void> {
        const nowMs = Date.now();
        const prior = await tx.read(
            this.toRepairsKey(repair.msgId),
            (value) => decodeALAdmissionControlValue(value, repair.msgId, 'repairs')
        );
        const nextRepairs = [...(prior?.values ?? []), repair];
        await tx.set(
            this.toRepairsKey(repair.msgId),
            { kind: 'repairs', values: nextRepairs },
            this.controlExpireAt(nowMs)
        );
        await this.effectStore.persistEffect(
            tx,
            this.toRepairHintEffectWrite<TPrepared>(repair.msgId, {
                trigger: 'repair',
                requestedByPeerId: repair.fromPeerId,
                orderingTrackKey: repair.orderingKey,
                missingSeqs: repair.missingSeqs ?? [],
                failedPeerIds: []
            }, repair.observedAtEpochMs),
            decodePrepared
        );
        await this.bumpOwnerVersion(tx, repair.msgId);
    }

    private async bumpOwnerVersion(tx: ALAdmissionWriteContext, msgId: string): Promise<void> {
        const senderId = await tx.read(`${this.namespace}:msg-owner:${msgId}`, decodeALAdmissionString);
        if (!senderId) {
            return;
        }
        const versionKey = `${this.namespace}:version:${senderId}`;
        const version =
            (await tx.read(versionKey, (value) => decodeALAdmissionClientRecord(value, senderId)))?.version ?? 0;
        await tx.set(
            versionKey,
            { senderId, version: version + 1 },
            toExpireAtTimestampFromNow(this.retention.versionTtlMs)
        );
    }

    private controlExpireAt(nowMs: number): number {
        return toExpireAtTimestampFromNow(this.retention.controlHistoryTtlMs, nowMs);
    }

    private toRepairHintEffectWrite<TPrepared>(
        msgId: string,
        request: ALOutboundRepairHint,
        observedAtMs: number
    ): ALOutboundDurableEffectWrite<TPrepared> {
        return {
            effectId: toALOutboundEffectId([
                'repair-hint',
                msgId,
                request.trigger,
                request.requestedByPeerId ?? '-',
                request.orderingTrackKey ?? '-',
                request.missingSeqs.join(','),
                observedAtMs
            ]),
            payload: { kind: 'repair-hint', msgId, request }
        };
    }

    private toAcksKey(msgId: string): string {
        return `${this.namespace}:control:acks:${msgId}`;
    }
    private toNacksKey(msgId: string): string {
        return `${this.namespace}:control:nacks:${msgId}`;
    }
    private toRepairsKey(msgId: string): string {
        return `${this.namespace}:control:repairs:${msgId}`;
    }
    private toPendingAckKey(msgId: string): string {
        return `${this.namespace}:pending-ack:${msgId}`;
    }
    private toRepairAttemptKey(msgId: string): string {
        return `${this.namespace}:repair-attempt:${msgId}`;
    }
}
