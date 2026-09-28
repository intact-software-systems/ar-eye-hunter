import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs } from '@shared/al-contracts/al-policy.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import {
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '@shared/alm/al-admission-value-validation.ts';
import { decodeALAdmissionResourceEntryKey } from '@shared/alm/decode-al-admission-resource-entry-key.ts';
import { decodeALOutboundRecipientScope } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import {
    isKeysEqual,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { requiresWsQueueBoxServerRecipientScope } from '@shared/services/ws-queue-box-server/requires-ws-queue-box-server-recipient-scope.ts';
import type { WsOutboxProducerAuthority } from '@shared/services/ws-queue-box-server/ws-queue-box-server-dequeue-authority.ts';

import type { RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { sha256CanonicalJson } from '../../protocol/canonical-json.ts';

export const WS_OUTBOX_PROVENANCE_NAMESPACE = 'ws-outbox-provenance';

export interface WsOutboxProvenance {
    readonly version: 1;
    readonly producerKind: 'state-sync-snapshot';
    readonly queueKey: Key;
    readonly typeId: string;
    readonly messageId: string;
    readonly senderId: string;
    readonly expiresAtMs: number;
    readonly target: WsOutboxScopedUnicastTarget;
    readonly digest: string;
}

export interface WsOutboxScopedUnicastTarget {
    readonly kind: 'scoped-unicast';
    readonly peerId: string;
    readonly scope: StateScope;
    readonly admittedAudience: readonly string[];
}

export namespace WsOutboxProvenanceReader {
    export interface Dependencies {
        readonly repository: Pick<RuntimeStateRepositoryLike, 'findEntry'>;
        readonly nowMs: () => number;
    }
}

/** Reads existing runtime-state sidecars; producer writes remain owned by their mutation transaction. */
export class WsOutboxProvenanceReader {
    private readonly dependencies: WsOutboxProvenanceReader.Dependencies;

    constructor(dependencies: WsOutboxProvenanceReader.Dependencies) {
        this.dependencies = dependencies;
    }

    async readProducerProvenance(message: ALMessage, entry: ResourceEntry): Promise<WsOutboxProducerAuthority> {
        const key = toWsOutboxProvenanceKey(entry.key);
        const stored = await this.dependencies.repository.findEntry(WS_OUTBOX_PROVENANCE_NAMESPACE, key);
        try {
            if (!stored || stored.key !== key) {
                throw new TypeError('WS producer provenance is missing or in the wrong slot');
            }
            const proof = decodeWsOutboxProvenance(JSON.parse(stored.value));
            if (!jsonEquals(decodePersistedALMessage(entry.resource), message)) {
                throw new TypeError('Observed WS message differs from its serialized row');
            }
            const issues = validateWsOutboxProvenance({ message, entry, proof, nowMs: this.dependencies.nowMs() });
            if (issues.length > 0 || stored.expireAtTimestamp !== proof.expiresAtMs) {
                throw new TypeError(issues.join('; ') || 'WS provenance storage expiry differs');
            }
            if (proof.digest !== await computeWsOutboxProvenanceDigest(entry, proof)) {
                throw new TypeError('WS producer provenance digest differs from its exact row');
            }
            if (proof.expiresAtMs <= this.dependencies.nowMs()) {
                throw new TypeError('WS producer provenance expired during verification');
            }
            return { admittedAudience: proof.target.admittedAudience, recipientScope: proof.target.scope };
        }
        catch (cause) {
            throw new ALAdmissionCorruptionError(key, toError(cause));
        }
    }
}

export function toWsOutboxProvenanceKey(key: Key): string {
    return `v1:${JSON.stringify([key.topicId, key.resourceId, key.contextId])}`;
}

/** Exact serialized payload and immutable audit facts are bound; queue attempts and DB metadata are not. */
export async function computeWsOutboxProvenanceDigest(
    entry: ResourceEntry,
    proof: Omit<WsOutboxProvenance, 'digest'>
): Promise<string> {
    return await sha256CanonicalJson({
        version: proof.version,
        producerKind: proof.producerKind,
        queueKey: proof.queueKey,
        typeId: proof.typeId,
        messageId: proof.messageId,
        senderId: proof.senderId,
        expiresAtMs: proof.expiresAtMs,
        target: proof.target,
        row: {
            key: entry.key,
            typeId: entry.typeId,
            resource: entry.resource,
            audit: {
                date: entry.audit.date.toString(),
                createdBy: entry.audit.createdBy,
                createdTs: entry.audit.createdTs.toString(),
                expiryTs: entry.audit.expiryTs.toString()
            }
        }
    });
}

export function decodeWsOutboxProvenance(value: unknown): WsOutboxProvenance {
    const proof = decodeALAdmissionRecord(value, [
        'version',
        'producerKind',
        'queueKey',
        'typeId',
        'messageId',
        'senderId',
        'expiresAtMs',
        'target',
        'digest'
    ]);
    if (proof.version !== 1 || proof.producerKind !== 'state-sync-snapshot') {
        throw new TypeError('Unsupported WS producer provenance version or kind');
    }
    const digest = decodeALAdmissionString(proof.digest);
    if (!/^[0-9a-f]{64}$/u.test(digest)) {
        throw new TypeError('WS producer provenance digest is malformed');
    }
    return {
        version: 1,
        producerKind: proof.producerKind,
        queueKey: decodeALAdmissionResourceEntryKey(proof.queueKey),
        typeId: decodeALAdmissionString(proof.typeId),
        messageId: decodeALAdmissionString(proof.messageId),
        senderId: decodeALAdmissionString(proof.senderId),
        expiresAtMs: decodeALAdmissionNumber(proof.expiresAtMs),
        target: decodeWsOutboxScopedUnicastTarget(proof.target),
        digest
    };
}

function decodeWsOutboxScopedUnicastTarget(value: unknown): WsOutboxScopedUnicastTarget {
    const target = decodeALAdmissionRecord(value, ['kind', 'peerId', 'scope', 'admittedAudience']);
    if (target.kind !== 'scoped-unicast' || !Array.isArray(target.admittedAudience)) {
        throw new TypeError('WS producer provenance requires a frozen scoped unicast target');
    }
    const admittedAudience = target.admittedAudience.map(decodeALAdmissionString);
    if (new Set(admittedAudience).size !== admittedAudience.length) {
        throw new TypeError('WS producer audience contains duplicates');
    }
    return {
        kind: 'scoped-unicast',
        peerId: decodeALAdmissionString(target.peerId),
        scope: decodeALOutboundRecipientScope(target.scope),
        admittedAudience
    };
}

interface WsOutboxProvenanceValidation {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly proof: WsOutboxProvenance;
    readonly nowMs: number;
}

function validateWsOutboxProvenance(input: WsOutboxProvenanceValidation): readonly string[] {
    const { message, entry, proof, nowMs } = input;
    const issues: string[] = [];
    const expiresAtMs = resolveALMessageExpireAtMs(message);
    if (
        !isKeysEqual(proof.queueKey, entry.key) || proof.typeId !== entry.typeId ||
        entry.typeId !== EnqueuedType.WS_OUTBOX || entry.key.topicId === 'AL_OUTBOUND_MESSAGE'
    ) {
        issues.push('WS provenance row identity differs');
    }
    if (proof.messageId !== message.id.msgId || proof.senderId !== message.id.senderId) {
        issues.push('WS provenance message identity differs');
    }
    if (
        proof.expiresAtMs !== entry.audit.expiryTs.epochMilliseconds || proof.expiresAtMs <= nowMs ||
        expiresAtMs === undefined || expiresAtMs <= nowMs || expiresAtMs > proof.expiresAtMs
    ) {
        issues.push('WS provenance is expired or has an inconsistent deadline');
    }
    if (
        message.targets?.mode !== 'unicast' || !requiresWsQueueBoxServerRecipientScope(message) ||
        message.targets.toPeerId !== proof.target.peerId ||
        proof.target.admittedAudience.some((peerId) => peerId !== proof.target.peerId)
    ) {
        issues.push('WS provenance target differs from public unicast identity');
    }
    return issues;
}
