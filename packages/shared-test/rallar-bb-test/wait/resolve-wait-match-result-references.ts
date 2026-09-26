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
    return contains === undefined
        ? Either.ofRight(match)
        : resolveResultReferencesInText(contains, resultCache).mapRight((resolved) => ({
            ...match,
            contains: resolved
        }));
}

/** The same tokens in any other command text, which then names an identity an earlier command returned. */
export function resolveResultReferencesInText(
    text: string,
    resultCache: RallarBlackBoxTestState['resultCache']
): Either<UnresolvedWaitMatchReference, string> {
    const texts = new Map<string, string>();
    for (const [, reference] of text.matchAll(RESULT_REFERENCE_PATTERN)) {
        const referenced = toReferencedResultText(reference, resultCache);
        if (referenced === undefined) {
            return Either.ofLeft({ reference });
        }
        texts.set(reference, referenced);
    }
    return Either.ofRight(
        text.replace(RESULT_REFERENCE_PATTERN, (token, reference: string) => texts.get(reference) ?? token)
    );
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
