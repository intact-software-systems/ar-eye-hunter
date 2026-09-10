import { decodePersistedALMessage } from '../../../al-contracts/al-message-persistence-validation.ts';

import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { hasSameResourceEntryValue } from '../../../queuebox/resource-entry-observations.ts';
import type { ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../../repository/state-utils.ts';
import { toError } from '../../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../../al-admission-decoder.ts';
import { decodeALAdmissionRecord } from '../../al-admission-value-validation.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../../al-admission-work-backend.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import type {
    ALOutboundDurableEffectWrite,
    ALOutboundEffectSnapshot,
    ALOutboundPreparedMessageDecoder
} from './al-outbound-admission-store.ts';
import {
    captureALOutboundCreationExpiry,
    decodeALOutboundCanonicalMessage,
    decodeALOutboundMessageReference,
    toALOutboundIdentityEntry,
    toALOutboundIdentityKey,
    type ALOutboundMessageReference
} from '../al-outbound-canonical-message.ts';
import { decodeALOutboundEffectPayload } from '../al-outbound-effect-validation.ts';
import {
    computeALOutboundWorkEntry,
    decodeALOutboundWorkEntry,
    toALOutboundWorkKey
} from '../al-outbound-work-entry.ts';

export interface ALOutboundEffectIssue {
    readonly code: string;
    readonly effectId: string;
    readonly message: string;
}

export interface ALOutboundEffectObservation<TPrepared> {
    readonly effect: ALOutboundDurableEffectWrite<TPrepared>;
    readonly existing: ResourceEntry | undefined;
    readonly message: ALMessage | undefined;
    readonly existingPayload: ALOutboundEffectSnapshot<TPrepared>['payload'] | undefined;
}

export interface ALOutboundEffectCandidate<TPrepared> {
    readonly read: ALOutboundEffectObservation<TPrepared>;
    readonly entry: ResourceEntry;
    readonly write: boolean;
}

export interface CreateALOutboundAdmissionEffectStoreInput<TPrepared> {
    readonly nowMs: () => number;
    readonly backend: ALAdmissionWorkBackend;
    readonly namespace: string;
    readonly canonicalScope: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;
}

/** Owns the durable-effect rows of one admission scope: their observation, candidacy and write. */
export class ALOutboundAdmissionEffectStore<TPrepared> {
    private readonly backend: ALAdmissionWorkBackend;
    private readonly nowMs: () => number;
    private readonly namespace: string;
    private readonly canonicalScope: string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;

    constructor(input: CreateALOutboundAdmissionEffectStoreInput<TPrepared>) {
        this.backend = input.backend;
        this.nowMs = input.nowMs;
        this.namespace = input.namespace;
        this.canonicalScope = input.canonicalScope;
        this.retention = input.retention;
        this.decodePrepared = input.decodePrepared;
    }

    async readEffects(
        effects: readonly ALOutboundDurableEffectWrite<TPrepared>[],
        canonicalEntry?: ResourceEntry
    ): Promise<readonly ALOutboundEffectObservation<TPrepared>[]> {
        return await Promise.all(effects.map(async (effect) => {
            const message = (effect.payload.kind === 'send-prepared' || effect.payload.kind === 'admit-message')
                ? await this.readReferencedMessage(effect.payload.message, canonicalEntry)
                : undefined;
            const existing = await this.backend.workQueue.getItem(toALOutboundWorkKey(this.namespace, effect.effectId));
            const preparedRead = { decodePrepared: this.decodePrepared, message };
            decodeALOutboundEffectPayload(effect.payload, effect.effectId, preparedRead);
            const existingPayload = existing
                ? decodeALOutboundWorkEntry(existing, this.namespace, preparedRead).payload
                : undefined;
            return { effect, message, existing, existingPayload };
        }));
    }

    /** Decodes one claimed queue row, reading the canonical message the payload references. */
    async readWorkSnapshot(entry: ResourceEntry): Promise<ALOutboundEffectSnapshot<TPrepared>> {
        return decodeALOutboundWorkEntry(entry, this.namespace, {
            decodePrepared: this.decodePrepared,
            message: await this.readWorkCanonicalMessage(entry)
        });
    }

    computeEffects(
        observations: readonly ALOutboundEffectObservation<TPrepared>[],
        observedAtMs: number
    ): readonly ALOutboundEffectCandidate<TPrepared>[] {
        return observations.map((read) => ({
            read,
            write: read.existing === undefined,
            entry: computeALOutboundWorkEntry({
                namespace: this.namespace,
                effectId: read.effect.effectId,
                payload: read.effect.payload,
                observedAtMs,
                expireAtTimestamp: read.effect.expireAtTimestamp ??
                    ((read.effect.payload.kind === 'send-prepared' || read.effect.payload.kind === 'admit-message')
                        ? read.effect.payload.message.expiresAtMs
                        : observedAtMs + this.retention.durableEffectTtlMs),
                retryAtMs: read.effect.retryAtMs ?? observedAtMs
            })
        }));
    }

    validateEffects(
        candidates: readonly ALOutboundEffectCandidate<TPrepared>[]
    ): readonly ALOutboundEffectIssue[] {
        const issues: ALOutboundEffectIssue[] = [];
        for (const candidate of candidates) {
            const effectId = candidate.read.effect.effectId;
            if (
                candidate.read.existingPayload &&
                !jsonEquals(candidate.read.existingPayload, candidate.read.effect.payload)
            ) {
                issues.push({
                    code: 'conflicting-content',
                    effectId,
                    message: 'Outbound action identity has conflicting content'
                });
            }
            if (candidate.entry.audit.expiryTs.epochMilliseconds <= 0) {
                issues.push({ code: 'invalid-deadline', effectId, message: 'Outbound action deadline is invalid' });
            }
        }
        return issues;
    }

    /** Re-reads each candidate's queue slot inside the write; a moved row is a conflict, never a throw. */
    async validateObservedWork(
        tx: ALAdmissionWorkWriteContext,
        candidates: readonly ALOutboundEffectCandidate<TPrepared>[]
    ): Promise<readonly ALOutboundEffectIssue[]> {
        const issues: ALOutboundEffectIssue[] = [];
        for (const candidate of candidates) {
            const existing = await tx.readWork(candidate.entry.key);
            const expected = candidate.read.existing;
            if (
                existing === undefined || expected === undefined
                    ? existing !== expected
                    : !hasSameResourceEntryValue(existing, expected)
            ) {
                issues.push({
                    code: 'observation-changed',
                    effectId: candidate.read.effect.effectId,
                    message: 'Outbound queue observation changed'
                });
            }
        }
        return issues;
    }

    writeEffects(
        tx: ALAdmissionWorkWriteContext,
        candidates: readonly ALOutboundEffectCandidate<TPrepared>[]
    ): void {
        for (const candidate of candidates) {
            if (candidate.write) {
                tx.writeWork(candidate.entry);
            }
        }
    }

    private async readWorkCanonicalMessage(entry: ResourceEntry): Promise<ALMessage | undefined> {
        const reference = readALOutboundWorkMessageReference(entry);
        return reference === undefined ? undefined : await this.readReferencedMessage(reference);
    }

    private async readReferencedMessage(
        reference: ALOutboundMessageReference,
        candidate?: ResourceEntry
    ): Promise<ALMessage> {
        if (reference.scope !== this.canonicalScope) {
            throw new ALAdmissionCorruptionError(
                JSON.stringify(reference.key),
                new TypeError('Outbound reference belongs to another local scope')
            );
        }
        const canonical = candidate ?? await this.backend.workQueue.getItem(reference.key);
        const identity = candidate
            ? toALOutboundIdentityEntry(
                reference,
                candidate,
                captureALOutboundCreationExpiry(decodePersistedALMessage(candidate.resource))
            )
            : await this.backend.workQueue.getItem(toALOutboundIdentityKey(reference.key));
        return decodeALOutboundCanonicalMessage(reference, canonical, identity);
    }
}

/** An unreadable row cannot name the message it owes: that is corruption, never a retryable failure. */
function readALOutboundWorkMessageReference(entry: ResourceEntry): ALOutboundMessageReference | undefined {
    try {
        const stored = decodeALAdmissionRecord(JSON.parse(entry.resource), ['namespace', 'effectId', 'payload']);
        const payload = decodeALAdmissionRecord(stored.payload, ['kind'], [
            'message',
            'prepared',
            'preparedFingerprint',
            'attemptIdentity',
            'phase',
            'msgId',
            'msg',
            'expiresAtMs',
            'queueTypeId',
            'request',
            'reason',
            'policy',
            'preparedMessages'
        ]);
        return payload.kind === 'send-prepared' || payload.kind === 'admit-message'
            ? decodeALOutboundMessageReference(payload.message)
            : undefined;
    }
    catch (error) {
        throw new ALAdmissionCorruptionError(JSON.stringify(entry.key), toError(error));
    }
}
