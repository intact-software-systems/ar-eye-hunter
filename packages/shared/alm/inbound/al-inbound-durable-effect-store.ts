import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import type { ALAdmissionBackend, ALAdmissionWriteContext } from '../al-admission-backend.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback, toExpireAtTimestampFromNow } from '../ALStoreRetention.ts';
import type {
    ALInboundDeliveryPredecessor,
    ALInboundDurableEffect,
    ALInboundDurableEffectWrite,
    ALPersistedInboundEffect,
    ClaimALInboundEffectsInput,
    RescheduleALInboundEffectInput
} from './al-inbound-admission-store.ts';
import { decodeALPersistedInboundEffect, toStoredPersistedInboundEffect } from './al-inbound-durable-effect-codec.ts';
import {
    assertALInboundDeliveryOwner,
    decodeALInboundBufferedSnapshot,
    type ALInboundOrderedDeliverySnapshot
} from './al-inbound-ordering-validation.ts';

export namespace ALInboundDurableEffectStore {
    export interface Dependencies {
        readonly backend: ALAdmissionBackend;
        readonly namespace: string;
        readonly retention: NormalizedALRuntimeStoreRetentionConfig;
        readonly nowMs: () => number;
    }
}

export class ALInboundDurableEffectStore {
    private readonly backend: ALAdmissionBackend;
    private readonly namespace: string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly nowMs: () => number;

    constructor(dependencies: ALInboundDurableEffectStore.Dependencies) {
        this.backend = dependencies.backend;
        this.namespace = dependencies.namespace;
        this.retention = dependencies.retention;
        this.nowMs = dependencies.nowMs;
    }

    async claimReadyEffects(input: ClaimALInboundEffectsInput): Promise<readonly ALPersistedInboundEffect[]> {
        if (input.maxCount <= 0) {
            return [];
        }
        return await this.backend.write((transaction) => this.writeEffectClaims(transaction, input));
    }

    private async writeEffectClaims(
        tx: ALAdmissionWriteContext,
        input: ClaimALInboundEffectsInput
    ): Promise<readonly ALPersistedInboundEffect[]> {
        const { workerId, maxCount, leaseMs, nowMs } = input;
        const claimed: ALPersistedInboundEffect[] = [];
        const prefix = this.toEffectPrefix();
        const effects = [
            ...await tx.list(
                prefix,
                (value, key) => decodeALPersistedInboundEffect(value, key.slice(prefix.length))
            )
        ]
            .map((entry) => entry.value)
            .sort((left, right) =>
                left.retryAtMs - right.retryAtMs ||
                left.effectId.localeCompare(right.effectId)
            );

        for (const effect of effects) {
            if (claimed.length >= maxCount) {
                break;
            }

            if (!this.isEffectReady(effect, nowMs)) {
                continue;
            }

            const nextEffect: ALPersistedInboundEffect = {
                ...effect,
                status: 'running',
                attempts: effect.attempts + 1,
                leaseOwner: workerId,
                leaseUntilMs: nowMs + leaseMs,
                updatedAtMs: nowMs
            };
            await tx.set(
                this.toEffectKey(effect.effectId),
                toStoredPersistedInboundEffect(nextEffect),
                effect.expireAtTimestamp
            );
            claimed.push(nextEffect);
        }

        return claimed;
    }

    async completeEffect(
        effectId: string,
        workerId: string
    ): Promise<void> {
        await this.backend.write(async (tx) => {
            const current = await tx.read(
                this.toEffectKey(effectId),
                (value) => decodeALPersistedInboundEffect(value, effectId)
            );
            if (!current || current.leaseOwner !== workerId) {
                return;
            }

            await tx.remove(this.toEffectKey(effectId));
        });
    }

    async rescheduleEffect(input: RescheduleALInboundEffectInput): Promise<void> {
        const { effectId, workerId, retryAtMs, lastError } = input;
        await this.backend.write(async (tx) => {
            const current = await tx.read(
                this.toEffectKey(effectId),
                (value) => decodeALPersistedInboundEffect(value, effectId)
            );
            if (!current || current.leaseOwner !== workerId) {
                return;
            }

            await tx.set(
                this.toEffectKey(effectId),
                toStoredPersistedInboundEffect(
                    {
                        ...current,
                        status: 'pending',
                        retryAtMs,
                        leaseOwner: undefined,
                        leaseUntilMs: undefined,
                        lastError,
                        updatedAtMs: this.nowMs()
                    } satisfies ALPersistedInboundEffect
                ),
                current.expireAtTimestamp
            );
        });
    }

    async readNextEffectReadyAt(): Promise<number | undefined> {
        let nextAt: number | undefined;

        const prefix = this.toEffectPrefix();
        for (
            const { value: effect } of await this.backend.list(
                prefix,
                (value, key) => decodeALPersistedInboundEffect(value, key.slice(prefix.length))
            )
        ) {
            const candidateAt = effect.leaseUntilMs ?? effect.retryAtMs;
            nextAt = nextAt === undefined ? candidateAt : Math.min(nextAt, candidateAt);
        }

        return nextAt;
    }

    async readDeliveryPredecessors(
        trackKey: string,
        beforeSeq: number
    ): Promise<readonly ALInboundDeliveryPredecessor[]> {
        return await this.backend.write((transaction) => this.readDeliveryOwners(transaction, trackKey, beforeSeq));
    }

    private async readDeliveryOwners(
        tx: ALAdmissionWriteContext,
        trackKey: string,
        beforeSeq: number
    ): Promise<readonly ALInboundDeliveryPredecessor[]> {
        const predecessors: ALInboundDeliveryPredecessor[] = [];
        const prefix = this.toBufferedTrackPrefix(trackKey);
        const snapshots = await tx.list(
            prefix,
            (value, key) => decodeALInboundBufferedSnapshot(value, { trackKey, prefix, key })
        );
        for (const { value: snapshot } of snapshots) {
            if (snapshot.seq >= beforeSeq || !snapshot.delivery) {
                continue;
            }
            const effectId = snapshot.delivery.effectId;
            const effect = await tx.read(
                this.toEffectKey(effectId),
                (value) => {
                    const effect = decodeALPersistedInboundEffect(value, effectId);
                    assertALInboundDeliveryOwner(effect.payload, snapshot);
                    return effect;
                }
            );
            if (effect && effect.expireAtTimestamp > this.nowMs()) {
                predecessors.push({ kind: 'effect' });
            }
            else if (snapshot.delivery.inboxKey) {
                predecessors.push({ kind: 'inbox', msg: snapshot.msg, key: snapshot.delivery.inboxKey });
            }
        }
        return predecessors;
    }

    async persistEffect(
        tx: ALAdmissionWriteContext,
        effect: ALInboundDurableEffectWrite
    ): Promise<void> {
        const key = this.toEffectKey(effect.effectId);
        const expireAtTimestamp = effect.expireAtTimestamp ?? this.resolveEffectExpireAtTimestamp(effect.payload);
        if (expireAtTimestamp <= this.nowMs()) {
            return;
        }

        const existing = await tx.read(key, (value) => decodeALPersistedInboundEffect(value, effect.effectId));
        if (existing) {
            return;
        }

        await tx.set(
            key,
            toStoredPersistedInboundEffect(
                {
                    effectId: effect.effectId,
                    payload: effect.payload,
                    status: 'pending',
                    attempts: 0,
                    retryAtMs: this.nowMs(),
                    updatedAtMs: this.nowMs(),
                    expireAtTimestamp
                } satisfies ALPersistedInboundEffect
            ),
            expireAtTimestamp
        );
        await this.trackEffectDelivery(tx, effect, expireAtTimestamp);
    }

    private async trackEffectDelivery(
        tx: ALAdmissionWriteContext,
        effect: ALInboundDurableEffectWrite,
        expireAtTimestamp: number
    ): Promise<void> {
        const payload = effect.payload;
        if (
            payload.kind !== 'dispatch-local' && payload.kind !== 'enqueue-inbox' && payload.kind !== 'release-buffered'
        ) {
            return;
        }
        const trackKey = payload.kind === 'release-buffered' ? payload.trackKey : toALOrderingTrackKey(payload.msg);
        const seq = payload.kind === 'release-buffered' ? payload.seq : payload.msg.ordering?.seq;
        if (trackKey === undefined || seq === undefined) {
            return;
        }
        const key = this.toBufferedKey(trackKey, seq);
        const prefix = this.toBufferedTrackPrefix(trackKey);
        const snapshot = await tx.read(
            key,
            (value, key) => decodeALInboundBufferedSnapshot(value, { trackKey, prefix, key })
        );
        if (!snapshot || (payload.kind !== 'release-buffered' && snapshot.msg.id.msgId !== payload.msg.id.msgId)) {
            return;
        }
        // Once admission has scheduled delivery, its real owner sets the fence lifetime.
        // Queue ownership is verified on consumption, including identity, status and expiry.
        const inboxKey = payload.kind === 'enqueue-inbox' ? payload.entry.key : undefined;
        const deliveryExpiry = payload.kind === 'enqueue-inbox'
            ? Math.max(expireAtTimestamp, payload.entry.audit.expiryTs.epochMilliseconds)
            : expireAtTimestamp;
        await tx.set(
            key,
            {
                ...snapshot,
                delivery: { effectId: effect.effectId, inboxKey }
            } satisfies ALInboundOrderedDeliverySnapshot,
            deliveryExpiry
        );
    }

    private resolveEffectExpireAtTimestamp(
        effect: ALInboundDurableEffect
    ): number {
        switch (effect.kind) {
            case 'dispatch-local':
            case 'enqueue-inbox':
            case 'forward-message':
                return resolveExpireAtTimestampWithFallback(
                    resolveALMessageExpireAtMs(effect.msg, effect.plan.effective),
                    this.retention.durableEffectTtlMs,
                    this.nowMs()
                );
            case 'send-control':
                return resolveExpireAtTimestampWithFallback(
                    resolveALMessageExpireAtMs(effect.msg),
                    this.retention.durableEffectTtlMs,
                    this.nowMs()
                );
            case 'release-buffered':
                return toExpireAtTimestampFromNow(this.retention.durableEffectTtlMs, this.nowMs());
        }
    }

    private isEffectReady(
        effect: ALPersistedInboundEffect,
        nowMs: number
    ): boolean {
        if (effect.status === 'pending') {
            return effect.retryAtMs <= nowMs;
        }

        return effect.leaseUntilMs !== undefined && effect.leaseUntilMs <= nowMs;
    }

    private toEffectKey(effectId: string): string {
        return `${this.namespace}:effect:${effectId}`;
    }

    private toEffectPrefix(): string {
        return `${this.namespace}:effect:`;
    }

    private toBufferedKey(trackKey: string, seq: number): string {
        return `${this.namespace}:buffered:${trackKey}:${seq}`;
    }

    private toBufferedTrackPrefix(trackKey: string): string {
        return `${this.namespace}:buffered:${trackKey}:`;
    }
}
