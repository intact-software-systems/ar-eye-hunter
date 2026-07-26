import type { MutationBoundaryLexicalValues } from './mutation-boundary-lexical-values.ts';
import { resolveStaticValues } from './mutation-static-semantics.ts';

type AstNode = { readonly type: string; readonly [key: string]: unknown };

export interface SwitchEntryResolution {
  readonly entryIndices: readonly number[];
  readonly noMatchPossible: boolean;
}

export function resolveSwitchEntries(
  discriminant: unknown,
  rawCases: unknown,
  lexical?: MutationBoundaryLexicalValues,
): SwitchEntryResolution {
  const cases = asNodes(rawCases);
  const exact = exactStaticValue(discriminant, lexical);
  if (exact.found) {
    const matchingIndex = cases.findIndex((candidate) =>
      candidate.test && staticValueEquals(candidate.test, exact.value, lexical)
    );
    const defaultIndex = cases.findIndex((candidate) => !candidate.test);
    const entryIndex = matchingIndex >= 0 ? matchingIndex : defaultIndex;
    return {
      entryIndices: entryIndex >= 0 ? [entryIndex] : [],
      noMatchPossible: entryIndex < 0,
    };
  }
  const defaultIndex = cases.findIndex((candidate) => !candidate.test);
  return {
    entryIndices: cases.map((_, index) => index),
    noMatchPossible: defaultIndex < 0,
  };
}

export function readSwitchFallthroughStatements(
  rawCases: unknown,
  entryIndex: number,
): readonly AstNode[] {
  const cases = asNodes(rawCases);
  const statements: AstNode[] = [];
  for (const switchCase of cases.slice(entryIndex)) {
    const consequent = asNodes(switchCase.consequent);
    for (const statement of consequent) {
      statements.push(statement);
      if (hasAbruptCompletion(statement)) return statements;
    }
  }
  return statements;
}

export function hasAbruptCompletion(value: unknown): boolean {
  const node = asNode(value);
  if (!node) return false;
  if (
    node.type === 'BreakStatement' ||
    node.type === 'ReturnStatement' ||
    node.type === 'ThrowStatement'
  ) return true;
  if (node.type === 'BlockStatement') {
    return sequenceHasAbruptCompletion(node.body);
  }
  if (node.type === 'IfStatement') {
    return !!node.alternate &&
      hasAbruptCompletion(node.consequent) &&
      hasAbruptCompletion(node.alternate);
  }
  return false;
}

function sequenceHasAbruptCompletion(value: unknown): boolean {
  for (const statement of asNodes(value)) {
    if (hasAbruptCompletion(statement)) return true;
  }
  return false;
}

function staticValueEquals(
  value: unknown,
  expected: unknown,
  lexical: MutationBoundaryLexicalValues | undefined,
): boolean {
  const resolution = resolveStaticValues(value, lexical);
  return resolution.values.size === 1 && [...resolution.values][0] === expected &&
    !resolution.unknownFalsy && !resolution.unknownTruthy;
}

function exactStaticValue(
  value: unknown,
  lexical: MutationBoundaryLexicalValues | undefined,
): { readonly found: boolean; readonly value: unknown } {
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
