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
import {
    decodeALSessionInvalidationAuthority,
    type ALSessionInvalidationAuthority
} from '@shared/alm/outbound/admission/al-session-invalidation-authority.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import {
    isKeysEqual,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { WsOutboxProducerAuthority } from '@shared/services/ws-queue-box-server/ws-queue-box-server-dequeue-authority.ts';

import type { RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { sha256CanonicalJson } from '../../protocol/canonical-json.ts';
import { validateWsOutboxProvenanceTarget } from './validate-ws-outbox-provenance-target.ts';

export const WS_OUTBOX_PROVENANCE_NAMESPACE = 'ws-outbox-provenance';

export interface WsOutboxProvenance {
    readonly version: 1;
    readonly producerKind: 'state-sync' | 'auth-session-invalidation' | 'crdt' | 'rtc-topology';
    readonly queueKey: Key;
    readonly typeId: string;
    readonly messageId: string;
    readonly senderId: string;
    readonly expiresAtMs: number;
    readonly target:
        | WsOutboxScopedUnicastTarget
        | WsOutboxInvalidatedSessionTarget
        | WsOutboxScopedRoomBroadcastTarget
        | WsOutboxScopedPrincipalBroadcastTarget
        | WsOutboxScopedPrincipalUnicastTarget
        | WsOutboxScopedWorldBroadcastTarget;
    readonly digest: string;
}

export interface WsOutboxInvalidatedSessionTarget {
    readonly kind: 'exact-invalidated-session';
    readonly sessionInvalidation: ALSessionInvalidationAuthority;
    readonly admittedAudience: readonly string[];
}

export interface WsOutboxScopedUnicastTarget {
    readonly kind: 'scoped-unicast';
    readonly peerId: string;
    readonly scope: StateScope;
    readonly admittedAudience: readonly string[];
}

export interface WsOutboxScopedRoomBroadcastTarget {
    readonly kind: 'scoped-room-broadcast';
    readonly groupRef: GroupRef;
    readonly admittedAudience: readonly string[];
}

export interface WsOutboxScopedPrincipalBroadcastTarget {
    readonly kind: 'scoped-principal-broadcast';
    readonly principalRef: ClientPrincipalRef;
    readonly admittedAudience: readonly string[];
}

export interface WsOutboxScopedPrincipalUnicastTarget {
    readonly kind: 'scoped-principal-unicast';
    readonly peerId: string;
    readonly principalRef: ClientPrincipalRef;
    readonly admittedAudience: readonly string[];
}

export interface WsOutboxScopedWorldBroadcastTarget {
    readonly kind: 'scoped-world-broadcast';
    readonly scope: StateScope;
}

interface WsOutboxProvenanceValidation {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly proof: WsOutboxProvenance;
    readonly nowMs: number;
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
            if (proof.target.kind === 'exact-invalidated-session') {
                return {
                    admittedAudience: proof.target.admittedAudience,
                    recipientScope: undefined,
                    sessionInvalidation: proof.target.sessionInvalidation
                };
            }
            if (proof.target.kind === 'scoped-world-broadcast') {
                return {
                    admittedAudience: undefined,
                    recipientScope: proof.target.scope,
                    broadWorld: true
                };
            }
            if (proof.target.kind === 'scoped-principal-unicast') {
                return {
                    admittedAudience: proof.target.admittedAudience,
                    recipientScope: {
                        applicationId: proof.target.principalRef.applicationId,
                        workspaceId: proof.target.principalRef.workspaceId
                    },
                    principalTargetId: proof.target.peerId
                };
            }
            const scope = proof.target.kind === 'scoped-unicast'
                ? proof.target.scope
                : proof.target.kind === 'scoped-room-broadcast'
                ? proof.target.groupRef
                : proof.target.principalRef;
            return {
                admittedAudience: proof.target.admittedAudience,
                recipientScope: { applicationId: scope.applicationId, workspaceId: scope.workspaceId }
            };
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
    if (
        proof.version !== 1 ||
        (proof.producerKind !== 'state-sync' && proof.producerKind !== 'auth-session-invalidation' &&
            proof.producerKind !== 'crdt' && proof.producerKind !== 'rtc-topology')
    ) {
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
        target: decodeWsOutboxProvenanceTarget(proof.target),
        digest
    };
}

function decodeWsOutboxProvenanceTarget(value: unknown): WsOutboxProvenance['target'] {
    const target = decodeALAdmissionRecord(value, ['kind'], [
        'peerId',
        'scope',
        'groupRef',
        'principalRef',
        'sessionInvalidation',
        'admittedAudience'
    ]);
    if (target.kind === 'scoped-world-broadcast') {
        decodeALAdmissionRecord(value, ['kind', 'scope']);
        return { kind: 'scoped-world-broadcast', scope: decodeALOutboundRecipientScope(target.scope) };
    }
    const admittedAudience = decodeProvenanceAudience(target.admittedAudience);
    if (target.kind === 'exact-invalidated-session') {
        decodeALAdmissionRecord(value, ['kind', 'sessionInvalidation', 'admittedAudience']);
        const sessionInvalidation = decodeALSessionInvalidationAuthority(target.sessionInvalidation);
        if (admittedAudience.length !== 1 || admittedAudience[0] !== sessionInvalidation.sessionId) {
            throw new TypeError('Invalidation audience differs from its exact session');
        }
        return { kind: 'exact-invalidated-session', sessionInvalidation, admittedAudience };
    }
    if (target.kind === 'scoped-unicast') {
        decodeALAdmissionRecord(value, ['kind', 'peerId', 'scope', 'admittedAudience']);
        return {
            kind: 'scoped-unicast',
            peerId: decodeALAdmissionString(target.peerId),
            scope: decodeALOutboundRecipientScope(target.scope),
            admittedAudience
        };
    }
    if (target.kind === 'scoped-room-broadcast') {
        decodeALAdmissionRecord(value, ['kind', 'groupRef', 'admittedAudience']);
        return {
            kind: 'scoped-room-broadcast',
            groupRef: decodeProvenanceGroupRef(target.groupRef),
            admittedAudience
        };
    }
    if (target.kind === 'scoped-principal-broadcast') {
        decodeALAdmissionRecord(value, ['kind', 'principalRef', 'admittedAudience']);
        return {
            kind: 'scoped-principal-broadcast',
            principalRef: decodePrincipalRef(target.principalRef),
            admittedAudience
        };
    }
    if (target.kind === 'scoped-principal-unicast') {
        decodeALAdmissionRecord(value, ['kind', 'peerId', 'principalRef', 'admittedAudience']);
        const peerId = decodeALAdmissionString(target.peerId);
        const principalRef = decodePrincipalRef(target.principalRef);
        if (peerId !== principalRef.principalId) {
            throw new TypeError('CRDT principal target differs from its scoped principal');
        }
        return { kind: 'scoped-principal-unicast', peerId, principalRef, admittedAudience };
    }
    throw new TypeError('WS producer provenance target kind is unsupported');
}

function decodeProvenanceAudience(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
        throw new TypeError('WS producer provenance requires a frozen audience');
    }
    const admittedAudience = value.map(decodeALAdmissionString);
    if (new Set(admittedAudience).size !== admittedAudience.length) {
        throw new TypeError('WS producer audience contains duplicates');
    }
    return admittedAudience;
}

function decodeProvenanceGroupRef(value: unknown): GroupRef {
    const groupRef = decodeALAdmissionRecord(value, ['applicationId', 'workspaceId', 'groupId']);
    return {
        applicationId: decodeALAdmissionString(groupRef.applicationId),
        workspaceId: decodeALAdmissionString(groupRef.workspaceId),
        groupId: decodeALAdmissionString(groupRef.groupId)
    };
}

function decodePrincipalRef(value: unknown): ClientPrincipalRef {
    const principalRef = decodeALAdmissionRecord(value, ['applicationId', 'workspaceId', 'principalId']);
    return {
        applicationId: decodeALAdmissionString(principalRef.applicationId),
        workspaceId: decodeALAdmissionString(principalRef.workspaceId),
        principalId: decodeALAdmissionString(principalRef.principalId)
    };
}

function validateWsOutboxProvenance(input: WsOutboxProvenanceValidation): readonly string[] {
    const { message, entry, proof, nowMs } = input;
    const issues: string[] = [];
    const expiresAtMs = resolveALMessageExpireAtMs(message);
    if (proof.producerKind === 'rtc-topology') {
        if (
            proof.target.kind !== 'scoped-room-broadcast' || message.targets?.mode !== 'broadcast' ||
            !jsonEquals(message.targets.recipientPeerIds, proof.target.admittedAudience)
        ) {
            issues.push('RTC topology provenance differs from its frozen page audience');
        }
    }
    if ((proof.producerKind === 'auth-session-invalidation') !== (proof.target.kind === 'exact-invalidated-session')) {
        issues.push('WS producer kind differs from authority variant');
    }
    if (
        (proof.target.kind === 'scoped-world-broadcast' || proof.target.kind === 'scoped-principal-unicast') &&
        proof.producerKind !== 'crdt'
    ) {
        issues.push('CRDT publication variant has another producer');
    }
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
    issues.push(...validateWsOutboxProvenanceTarget(message, proof.target));
    return issues;
}
