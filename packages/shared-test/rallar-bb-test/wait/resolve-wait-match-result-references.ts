import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestState, RallarBlackBoxTestWaitMatch } from '../rallar-black-box-test-contracts.ts';

import { decodePayloadPathValue } from './wait-event-match.ts';

export interface UnresolvedWaitMatchReference {
    readonly reference: string;
}

const RESULT_REFERENCE_PATTERN = /\{(resultCache\.[^{}]+)\}/g;
const RESULT_REFERENCE_ROOT = 'resultCache.';

/**
 * A `{resultCache.<commandId>.<path>}` token in `contains` stands for a string or number an earlier command of the same
 * runtime returned, so a wait can pin on an identity the recipe cannot know when it is authored, such as a msgId.
 */
export function resolveWaitMatchResultReferences(
    match: RallarBlackBoxTestWaitMatch,
    resultCache: RallarBlackBoxTestState['resultCache']
): Either<UnresolvedWaitMatchReference, RallarBlackBoxTestWaitMatch> {
    const contains = match.contains;
    if (contains === undefined) {
        return Either.ofRight(match);
    }
    const texts = new Map<string, string>();
    for (const [, reference] of contains.matchAll(RESULT_REFERENCE_PATTERN)) {
        const text = toReferencedResultText(reference, resultCache);
        if (text === undefined) {
            return Either.ofLeft({ reference });
        }
        texts.set(reference, text);
    }
    return Either.ofRight({
        ...match,
        contains: contains.replace(
            RESULT_REFERENCE_PATTERN,
            (token, reference: string) => texts.get(reference) ?? token
        )
    });
}

function toReferencedResultText(
    reference: string,
    resultCache: RallarBlackBoxTestState['resultCache']
): string | undefined {
    const lookup = decodePayloadPathValue(resultCache, reference.slice(RESULT_REFERENCE_ROOT.length));
    if (!lookup.exists) {
        return undefined;
    }
    return typeof lookup.value === 'string' || typeof lookup.value === 'number' ? String(lookup.value) : undefined;
}
