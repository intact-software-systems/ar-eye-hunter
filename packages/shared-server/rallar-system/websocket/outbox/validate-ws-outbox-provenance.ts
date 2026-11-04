import { type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '@shared/al-contracts/al-policy.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import { hasGroupMoveChangedTopic } from '@shared/api/mutation/group-move-changed.ts';
import { isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { validateWsOutboxProvenanceTarget } from './validate-ws-outbox-provenance-target.ts';
import type { WsOutboxProvenance } from './ws-outbox-provenance.ts';

interface WsOutboxProvenanceValidation {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly proof: WsOutboxProvenance;
    readonly nowMs: number;
}

export function validateWsOutboxProvenance(input: WsOutboxProvenanceValidation): readonly string[] {
    const { message, entry, proof, nowMs } = input;
    const issues: string[] = [];
    const expiresAtMs = resolveALMessageExpireAtMs(message);
    issues.push(...validateViewProducer(message, proof));
    if (proof.producerKind === 'rtc-topology' || proof.producerKind === 'room-application') {
        const principalPublication = proof.producerKind === 'room-application' &&
            proof.target.kind === 'scoped-principal-broadcast';
        // Principal envelopes carry no recipient list. Their committed proof freezes the audience,
        // just as it does for client state-sync; validation below binds the exact scoped principal.
        if (
            !principalPublication && (
                proof.target.kind !== 'scoped-room-broadcast' || message.targets?.mode !== 'broadcast' ||
                !jsonEquals(message.targets.recipientPeerIds, proof.target.admittedAudience)
            )
        ) {
            issues.push('Room publication provenance differs from its frozen audience');
        }
    }
    if ((proof.producerKind === 'auth-session-invalidation') !== (proof.target.kind === 'exact-invalidated-session')) {
        issues.push('WS producer kind differs from authority variant');
    }
    if (
        (proof.target.kind === 'scoped-world-broadcast' || proof.target.kind === 'scoped-principal-unicast') &&
        proof.producerKind !== 'crdt' &&
        !(proof.target.kind === 'scoped-world-broadcast' && proof.producerKind === 'view-invalidation')
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

/** Reserved view and Move Together envelopes each require their own producer and exact audience. */
function validateViewProducer(message: ALMessage, proof: WsOutboxProvenance): readonly string[] {
    if (hasGroupMoveChangedTopic(message) || proof.producerKind === 'group-move') {
        return hasGroupMoveChangedTopic(message) && proof.producerKind === 'group-move' &&
                proof.target.kind === 'scoped-account-view'
            ? []
            : ['Move Together notices require their scoped account producer'];
    }
    const issues: string[] = [];
    if (
        (proof.producerKind === 'view-invalidation') !==
            (proof.target.kind === 'scoped-account-view' || proof.target.kind === 'account-view' ||
                (proof.target.kind === 'scoped-world-broadcast' &&
                    message.route.topicId === AppTopics.viewInvalidated &&
                    message.payload.typeId === AppTopics.viewInvalidated))
    ) {
        issues.push('View invalidation producer differs from its account or public catalog authority');
    }
    if (
        (message.route.topicId === AppTopics.viewInvalidated || message.payload.typeId === AppTopics.viewInvalidated) &&
        proof.producerKind !== 'view-invalidation'
    ) {
        issues.push('Reserved view topics require their committed view publisher');
    }
    return issues;
}
