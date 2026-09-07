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
): Either<ALMessageRejection, ALOutboundComputedDto<TPrepared>> {
    const messageValidation = validateALOutboundPlannedMessage(read.originalMsg, read.msg);
    if (messageValidation.left) {
        return Either.ofLeft(messageValidation.left);
    }
    const bundle = computed.bundle;
    if (!bundle) {
        return Either.ofRight(computed);
    }
    if (bundle.senderId !== read.msg.id.senderId || bundle.expectedVersion !== read.clientRecord?.version) {
        return Either.ofLeft({
            code: 'malformed',
            message: 'Outbound candidate differs from its observed sender fence'
        });
    }
    for (const mutation of bundle.mutations) {
        if (
            mutation.kind === 'set-supersedence-latest' &&
            (mutation.supersedenceKey !== read.supersedence.key ||
                !jsonEquals(mutation.expected, read.supersedence.latest))
        ) {
            return Either.ofLeft({
                code: 'malformed',
                message: 'Outbound candidate differs from its observed shared supersedence'
            });
        }
    }
    const effectRejection = validateDispatchEffects(bundle, read.msg);
    return effectRejection ? Either.ofLeft(effectRejection) : Either.ofRight(computed);
}

export function validateALOutboundPlannedMessage(
    original: ALMessage,
    planned: unknown
): Either<ALMessageRejection, ALMessage> {
    const decoded = decodeALMessageValue(planned);
    if (decoded.left) {
        return decoded;
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
        return Either.ofLeft({
            code: 'malformed',
            message: 'Outbound planned message changes original authority or deadline'
        });
    }
    return Either.ofRight(msg);
}

function validateDispatchEffects<TPrepared>(
    bundle: ALOutboundCommitBundle<TPrepared>,
    msg: ALMessage
): ALMessageRejection | undefined {
    const effectIds = new Set<string>();
    for (const effect of bundle.durableEffects) {
        if (
            effectIds.has(effect.effectId) || effect.retryAtMs === undefined ||
            !Number.isSafeInteger(effect.retryAtMs) || effect.retryAtMs < 0
        ) {
            return {
                code: 'malformed',
                message: 'Outbound candidate has invalid effect identity or retry time'
            };
        }
        effectIds.add(effect.effectId);
        const payload = effect.payload;
        const messageMatches = 'msg' in payload
            ? jsonEquals(payload.msg, msg)
            : payload.msgId === msg.id.msgId;
        if (
            'msg' in payload && (!Number.isSafeInteger(effect.expireAtTimestamp) ||
                effect.expireAtTimestamp !== resolveALMessageExpireAtMs(msg))
        ) {
            return { code: 'malformed', message: 'Outbound work deadline differs from its message' };
        }
        if (!messageMatches) {
            return { code: 'malformed', message: 'Outbound effect candidate differs from its message' };
        }
        if (payload.kind === 'enqueue-outbox' || payload.kind === 'fallback-dispatch') {
            const rejection = validateQueueMessage(payload.entry, msg);
            if (rejection) {
                return rejection;
            }
        }
    }
    return undefined;
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

function toMessageAuthority(msg: ALMessage) {
    return {
        ...msg,
        qos: { ...msg.qos, expiry: undefined },
        constraints: { ...msg.constraints, expiresAtMs: undefined },
        diagnostics: { ...msg.diagnostics, visitedPeerIds: undefined }
    };
}
