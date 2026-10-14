import { Either } from '@shared/resilience/Either.ts';

import type {
    RallarBlackBoxTestFaultInjectCommand,
    RallarBlackBoxTestState
} from '../rallar-black-box-test-contracts.ts';
import { resolveResultReferencesInText } from '../wait/resolve-wait-match-result-references.ts';

/**
 * A transport fault that holds one message names it by the id its send returned, so `match.msgId` may name a
 * `{resultCache.<commandId>.<path>}` token. A storage fault's match names no message and passes through.
 */
export function resolveAlmFaultMatchReferences(
    fault: RallarBlackBoxTestFaultInjectCommand,
    resultCache: RallarBlackBoxTestState['resultCache']
): Either<string, RallarBlackBoxTestFaultInjectCommand['match']> {
    if (fault.carrier === 'storage' || fault.match.msgId === undefined) {
        return Either.ofRight(fault.match);
    }
    const msgId = resolveResultReferencesInText(fault.match.msgId, resultCache);
    return msgId.left === undefined
        ? Either.ofRight({ ...fault.match, msgId: msgId.right! })
        : Either.ofLeft(
            `fault.inject names ${msgId.left.reference}, which no earlier command of this recipe returned.`
        );
}
