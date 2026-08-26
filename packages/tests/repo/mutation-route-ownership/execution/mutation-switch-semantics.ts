import type { MutationBoundaryLexicalValues } from '../boundary/lexical/mutation-boundary-lexical-values.ts';
import { resolveStaticValues } from './mutation-static-semantics.ts';

type AstNode = { readonly type: string; readonly [key: string]: unknown; };

export interface SwitchEntryResolution {
    readonly entryIndices: readonly number[];
    readonly noMatchPossible: boolean;
}

export function resolveSwitchEntries(
    discriminant: unknown,
    rawCases: unknown,
    lexical?: MutationBoundaryLexicalValues
): SwitchEntryResolution {
    const cases = asNodes(rawCases);
    const exact = exactStaticValue(discriminant, lexical);
    if (exact.found) {
        const matchingIndex = cases.findIndex((candidate) => candidate.test && staticValueEquals(candidate.test, exact.value, lexical));
        const defaultIndex = cases.findIndex((candidate) => !candidate.test);
        const entryIndex = matchingIndex >= 0 ? matchingIndex : defaultIndex;
        return {
            entryIndices: entryIndex >= 0 ? [entryIndex] : [],
            noMatchPossible: entryIndex < 0
        };
    }
    const defaultIndex = cases.findIndex((candidate) => !candidate.test);
    return {
        entryIndices: cases.map((_, index) => index),
        noMatchPossible: defaultIndex < 0
    };
}

function staticValueEquals(
    value: unknown,
    expected: unknown,
    lexical: MutationBoundaryLexicalValues | undefined
): boolean {
    const resolution = resolveStaticValues(value, lexical);
    return resolution.values.size === 1 && [...resolution.values][0] === expected &&
        !resolution.unknownFalsy && !resolution.unknownTruthy;
}

function exactStaticValue(
    value: unknown,
    lexical: MutationBoundaryLexicalValues | undefined
): { readonly found: boolean; readonly value: unknown; } {
    const resolution = resolveStaticValues(value, lexical);
    return resolution.values.size === 1 &&
            !resolution.unknownFalsy && !resolution.unknownTruthy
        ? { found: true, value: [...resolution.values][0] }
        : { found: false, value: undefined };
}

function asNode(value: unknown): AstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
    return Array.isArray(value)
        ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
        : [];
}
