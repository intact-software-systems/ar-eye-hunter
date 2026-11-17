import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestState, RallarBlackBoxTestWaitMatch } from '../rallar-black-box-test-contracts.ts';

import { decodePayloadPathValue } from './wait-event-match.ts';

export interface UnresolvedWaitMatchReference {
    readonly reference: string;
}

export type InvalidWaitTimeoutFrom =
    | Readonly<{ kind: 'not-one-reference'; timeoutFrom: string; }>
    | Readonly<{ kind: 'unresolved-reference'; reference: string; }>;

export type InvalidWaitPayloadMinimum =
    | Readonly<{ kind: 'not-one-reference'; path: string; minimum: string; }>
    | Readonly<{ kind: 'unresolved-reference'; path: string; reference: string; }>;

type InvalidResultNumberReference =
    | Readonly<{ kind: 'not-one-reference'; }>
    | Readonly<{ kind: 'unresolved-reference'; reference: string; }>;

type ResolvedPayloadMinimums = Readonly<Record<string, number>>;

/**
 * A wait's `timeoutFrom` as a recipe authors it: exactly one result reference, which a loop child may key by its
 * `{loop.*}` placeholders; the schema and the control validation hold a recipe to it when it is loaded.
 */
export const WAIT_TIMEOUT_FROM_PATTERN_SOURCE =
    '^\\{resultCache\\.(?:[^{}]|\\{loop\\.(?:index|iteration|elapsedMs|commandIndex)\\})+\\}$';

const RESULT_REFERENCE_PATTERN = /\{(resultCache\.[^{}]+)\}/g;
const SINGLE_RESULT_REFERENCE_PATTERN = /^\{(resultCache\.[^{}]+)\}$/;
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
    for (const reference of readResultReferencesInText(text)) {
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

/** A wait's `timeoutFrom` is exactly one token naming a finite number, the epoch an earlier command returned. */
export function resolveWaitTimeoutFromEpochMs(
    timeoutFrom: string,
    resultCache: RallarBlackBoxTestState['resultCache']
): Either<InvalidWaitTimeoutFrom, number> {
    return resolveResultNumber(timeoutFrom, resultCache).mapLeft((invalid): InvalidWaitTimeoutFrom =>
        invalid.kind === 'not-one-reference' ? { kind: invalid.kind, timeoutFrom } : invalid
    );
}

/** A text floor carries the `timeoutFrom` grammar and resolves to the finite number an earlier command returned. */
export function resolveWaitPayloadMinimums(
    match: RallarBlackBoxTestWaitMatch,
    resultCache: RallarBlackBoxTestState['resultCache']
): Either<InvalidWaitPayloadMinimum, RallarBlackBoxTestWaitMatch> {
    const payloadMinimums = match.payloadMinimums;
    if (payloadMinimums === undefined) {
        return Either.ofRight(match);
    }
    return Object.entries(payloadMinimums).reduce(
        (resolved, [path, minimum]) =>
            resolved.flatMap(
                (invalid) => Either.ofLeft<InvalidWaitPayloadMinimum, ResolvedPayloadMinimums>(invalid),
                (floors) =>
                    resolveWaitPayloadMinimum(path, minimum, resultCache).mapRight((floor) => ({
                        ...floors,
                        [path]: floor
                    }))
            ),
        Either.ofRight<InvalidWaitPayloadMinimum, ResolvedPayloadMinimums>({})
    ).mapRight((floors) => ({ ...match, payloadMinimums: floors }));
}

function resolveWaitPayloadMinimum(
    path: string,
    minimum: number | string,
    resultCache: RallarBlackBoxTestState['resultCache']
): Either<InvalidWaitPayloadMinimum, number> {
    if (typeof minimum === 'number') {
        return Either.ofRight(minimum);
    }
    return resolveResultNumber(minimum, resultCache).mapLeft((invalid): InvalidWaitPayloadMinimum =>
        invalid.kind === 'not-one-reference' ? { kind: invalid.kind, path, minimum } : { ...invalid, path }
    );
}

function resolveResultNumber(
    text: string,
    resultCache: RallarBlackBoxTestState['resultCache']
): Either<InvalidResultNumberReference, number> {
    const reference = SINGLE_RESULT_REFERENCE_PATTERN.exec(text)?.[1];
    if (reference === undefined) {
        return Either.ofLeft({ kind: 'not-one-reference' });
    }
    const lookup = decodePayloadPathValue(resultCache, reference.slice(RESULT_REFERENCE_ROOT.length));
    return lookup.exists && typeof lookup.value === 'number' && Number.isFinite(lookup.value)
        ? Either.ofRight(lookup.value)
        : Either.ofLeft({ kind: 'unresolved-reference', reference });
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

/** Shared token grammar for resolution and released-result admission. */
export function readResultReferencesInText(text: string): readonly string[] {
    return [...text.matchAll(RESULT_REFERENCE_PATTERN)].map((match) => match[1]);
}
