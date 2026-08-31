import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALNackPayload,
    ALRepairPayload
} from '../../al-contracts/al-control.ts';
import { parseALControlMessage } from '../../al-contracts/al-control.ts';
import type { ALOutboundPendingAckSnapshot, ALOutboundRepairAttemptSnapshot } from '../al-runtime-state-stores.ts';
import { toExpireAtTimestampFromNow, type NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import type { ALAdmissionBackend, ALAdmissionWriteContext } from '../al-admission-backend.ts';
import { ALOutboundAdmissionEffectStore } from './al-outbound-admission-effect-store.ts';
import type {
    ALOutboundControlAcceptance,
    ALOutboundDurableEffectWrite,
    ALOutboundRepairHint,
    ALOutboundVersionedClientRecord
} from './al-outbound-admission-store.ts';
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

type OutboundControlValue =
    | Readonly<{ kind: 'acks'; values: readonly ALAckPayload[]; }>
    | Readonly<{ kind: 'nacks'; values: readonly ALNackPayload[]; }>
    | Readonly<{ kind: 'repairs'; values: readonly ALRepairPayload[]; }>;

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

    async acceptControlMessage<TPrepared>(msg: ALMessage): Promise<ALOutboundControlAcceptance> {
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
                    await this.acceptNack<TPrepared>(tx, parsed.payload, Date.now());
                    break;
                case 'repair':
                    await this.acceptRepair<TPrepared>(tx, parsed.payload, Date.now());
                    break;
            }
            return { handled: true };
        });
    }

    async readAcks(msgId: string): Promise<readonly ALAckPayload[]> {
        return toAcks(await this.backend.get<OutboundControlValue>(this.toAcksKey(msgId)));
    }

    async readNacks(msgId: string): Promise<readonly ALNackPayload[]> {
        return toNacks(await this.backend.get<OutboundControlValue>(this.toNacksKey(msgId)));
    }

    async readRepairs(msgId: string): Promise<readonly ALRepairPayload[]> {
        return toRepairs(await this.backend.get<OutboundControlValue>(this.toRepairsKey(msgId)));
    }

    private async acceptAck(tx: ALAdmissionWriteContext, ack: ALAckPayload, nowMs: number): Promise<void> {
        const nextAcks = appendUniqueALAck({
            current: toAcks(await tx.get<OutboundControlValue>(this.toAcksKey(ack.ackedMsgId))),
            next: ack
        });
        const current = await tx.get<ALOutboundPendingAckSnapshot>(this.toPendingAckKey(ack.ackedMsgId));
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
        nowMs: number
    ): Promise<void> {
        const nextNacks = [...toNacks(await tx.get<OutboundControlValue>(this.toNacksKey(nack.msgId))), nack];
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
                }, nack.observedAtEpochMs)
            );
        }
        await this.bumpOwnerVersion(tx, nack.msgId);
    }

    private async acceptRepair<TPrepared>(
        tx: ALAdmissionWriteContext,
        repair: ALRepairPayload,
        nowMs: number
    ): Promise<void> {
        const nextRepairs = [...toRepairs(await tx.get<OutboundControlValue>(this.toRepairsKey(repair.msgId))), repair];
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
            }, repair.observedAtEpochMs)
        );
        await this.bumpOwnerVersion(tx, repair.msgId);
    }

    private async bumpOwnerVersion(tx: ALAdmissionWriteContext, msgId: string): Promise<void> {
        const senderId = await tx.get<string>(`${this.namespace}:msg-owner:${msgId}`);
        if (!senderId) {
            return;
        }
        const versionKey = `${this.namespace}:version:${senderId}`;
        const version = (await tx.get<ALOutboundVersionedClientRecord>(versionKey))?.version ?? 0;
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

function toAcks(value: OutboundControlValue | undefined): readonly ALAckPayload[] {
    return value?.kind === 'acks' ? value.values : [];
}
function toNacks(value: OutboundControlValue | undefined): readonly ALNackPayload[] {
    return value?.kind === 'nacks' ? value.values : [];
}
function toRepairs(value: OutboundControlValue | undefined): readonly ALRepairPayload[] {
    return value?.kind === 'repairs' ? value.values : [];
}
