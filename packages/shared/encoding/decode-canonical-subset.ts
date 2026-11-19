import { Either } from '../resilience/Either.ts';

/** A subset of `known` with no duplicates, in the order of `known`: anything else is refused, never normalized. */
export function decodeCanonicalSubset<Known extends string>(
    value: unknown,
    known: readonly Known[],
    label: string
): Either<string, readonly Known[]> {
    if (!Array.isArray(value)) {
        return Either.ofLeft(`${label} must be an array`);
    }
    const subset = known.filter((member) => value.includes(member));
    if (subset.length !== value.length || subset.some((member, index) => member !== value[index])) {
        return Either.ofLeft(`${label} must be known, unique and in canonical order`);
    }
    return Either.ofRight(subset);
}
