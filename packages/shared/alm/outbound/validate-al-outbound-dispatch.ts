import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALMessage, type ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import type { ALOutboundMessageReadDto } from './al-outbound-admission-store.ts';
import type { ALOutboundComputedDto } from './compute-al-outbound-dispatch.ts';

/** Checks the candidate against its captured read; never repairs or rewrites it. */
export function validateALOutboundDispatch<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    computed: ALOutboundComputedDto<TPrepared>
): Either<ALMessageRejection, ALOutboundComputedDto<TPrepared>> {
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
    const effectIds = new Set<string>();
    for (const effect of bundle.durableEffects) {
        if (
            effectIds.has(effect.effectId) || effect.retryAtMs === undefined ||
            !Number.isSafeInteger(effect.retryAtMs) || effect.retryAtMs < 0
        ) {
            return Either.ofLeft({
                code: 'malformed',
                message: 'Outbound candidate has invalid effect identity or retry time'
            });
        }
        effectIds.add(effect.effectId);
        const payload = effect.payload;
        const messageMatches = 'msg' in payload
            ? jsonEquals(payload.msg, read.msg)
            : payload.msgId === read.msg.id.msgId;
        if (!messageMatches) {
            return Either.ofLeft({ code: 'malformed', message: 'Outbound effect candidate differs from its message' });
        }
        if (payload.kind === 'enqueue-outbox' || payload.kind === 'fallback-dispatch') {
            const rejection = validateQueueMessage(payload.entry, read.msg);
            if (rejection) {
                return Either.ofLeft(rejection);
            }
        }
    }
    return Either.ofRight(computed);
}

function validateQueueMessage(entry: ResourceEntry, message: ALMessage): ALMessageRejection | undefined {
    const decoded = decodeALMessage(entry.resource);
    if (decoded.left) {
        return decoded.left;
    }
    return jsonEquals(decoded.right, message)
        ? undefined
        : { code: 'malformed', message: 'Outbound queue candidate differs from its message' };
}
