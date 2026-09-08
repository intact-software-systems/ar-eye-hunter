import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodeALMessage,
    decodeALMessageValue,
    type ALMessageRejection
} from '../../al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import type { ALOutboundCommitBundle, ALOutboundMessageReadDto } from './al-outbound-admission-store.ts';
import type { ALOutboundComputedDto } from './compute-al-outbound-dispatch.ts';

/** Checks the candidate against its captured read; never repairs or rewrites it. */
export function validateALOutboundDispatch<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    computed: ALOutboundComputedDto<TPrepared>
): Either<readonly ALMessageRejection[], ALOutboundComputedDto<TPrepared>> {
    const issues = [...validateALOutboundPlannedMessage(read.originalMsg, read.msg)];
    const bundle = computed.bundle;
    if (!bundle) {
        return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(computed);
    }
    if (bundle.canonicalEntry) {
        const queueRejection = validateQueueMessage(bundle.canonicalEntry, read.msg);
        if (queueRejection) {
            issues.push(queueRejection);
        }
    }
    if (bundle.senderId !== read.msg.id.senderId || bundle.expectedVersion !== read.clientRecord?.version) {
        issues.push({ code: 'malformed', message: 'Outbound candidate differs from its observed sender fence' });
    }
    for (const mutation of bundle.mutations) {
        if (
            mutation.kind === 'set-supersedence-latest' &&
            (mutation.supersedenceKey !== read.supersedence.key ||
                !jsonEquals(mutation.expected, read.supersedence.latest))
        ) {
            issues.push({
                code: 'malformed',
                message: 'Outbound candidate differs from its observed shared supersedence'
            });
        }
    }
    issues.push(...validateDispatchEffects(bundle, read.msg));
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(computed);
}

export function validateALOutboundPlannedMessage(
    original: ALMessage,
    planned: unknown
): readonly ALMessageRejection[] {
    const decoded = decodeALMessageValue(planned);
    if (decoded.left) {
        return [decoded.left];
    }
    const msg = decoded.right!;
    const deadline = resolveALMessageExpireAtMs(msg);
    if (
        !Number.isSafeInteger(deadline) ||
        (original.constraints?.expiresAtMs !== undefined && deadline! > original.constraints.expiresAtMs) ||
        !jsonEquals(toMessageAuthority(original), toMessageAuthority(msg)) ||
        !(original.diagnostics?.visitedPeerIds ?? []).every((peerId, index) =>
            msg.diagnostics?.visitedPeerIds?.[index] === peerId
        )
    ) {
        return [{ code: 'malformed', message: 'Outbound planned message changes original authority or deadline' }];
    }
    return [];
}

function validateDispatchEffects<TPrepared>(
    bundle: ALOutboundCommitBundle<TPrepared>,
    msg: ALMessage
): readonly ALMessageRejection[] {
    const issues: ALMessageRejection[] = [];
    const effectIds = new Set<string>();
    for (const effect of bundle.durableEffects) {
        if (
            effectIds.has(effect.effectId) || effect.retryAtMs === undefined ||
            !Number.isSafeInteger(effect.retryAtMs) || effect.retryAtMs < 0
        ) {
            issues.push({ code: 'malformed', message: 'Outbound candidate has invalid effect identity or retry time' });
        }
        effectIds.add(effect.effectId);
        const payload = effect.payload;
        const messageMatches = (payload.kind === 'send-prepared' || payload.kind === 'admit-message')
            ? payload.message.msgId === msg.id.msgId && payload.message.senderId === msg.id.senderId &&
                payload.message.expiresAtMs === resolveALMessageExpireAtMs(msg)
            : payload.msgId === msg.id.msgId;
        if (
            (payload.kind === 'send-prepared' || payload.kind === 'admit-message') &&
            (!Number.isSafeInteger(effect.expireAtTimestamp) ||
                effect.expireAtTimestamp !== resolveALMessageExpireAtMs(msg))
        ) {
            issues.push({ code: 'malformed', message: 'Outbound work deadline differs from its message' });
        }
        if (!messageMatches) {
            issues.push({ code: 'malformed', message: 'Outbound effect candidate differs from its message' });
        }
    }
    return issues;
}

function validateQueueMessage(entry: ResourceEntry, message: ALMessage): ALMessageRejection | undefined {
    const decoded = decodeALMessage(entry.resource);
    if (decoded.left) {
        return decoded.left;
    }
    return jsonEquals(decoded.right, message) &&
            Number(entry.audit.expiryTs.epochMilliseconds) === resolveALMessageExpireAtMs(message)
        ? undefined
        : { code: 'malformed', message: 'Outbound queue candidate differs from its message' };
}

function toMessageAuthority(msg: ALMessage): ALMessage {
    return {
        ...msg,
        qos: { ...msg.qos, expiry: undefined },
        constraints: { ...msg.constraints, expiresAtMs: undefined },
        diagnostics: { ...msg.diagnostics, visitedPeerIds: undefined }
    };
}
