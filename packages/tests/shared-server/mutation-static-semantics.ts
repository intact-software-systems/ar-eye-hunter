import type { MutationBoundaryLexicalValues } from './mutation-boundary-lexical-values.ts';

type AstNode = { readonly type: string; readonly [key: string]: unknown };
type StaticPrimitive = boolean | null | number | string | undefined;

export interface StaticValueResolution {
  readonly unknownFalsy: boolean;
  readonly unknownTruthy: boolean;
  readonly values: ReadonlySet<StaticPrimitive>;
}

export interface StaticPropertyKeyResolution {
  readonly names: ReadonlySet<string>;
  readonly unknown: boolean;
}

export function resolveStaticValues(
  value: unknown,
  lexical?: MutationBoundaryLexicalValues,
  resolving = new Set<string>(),
): StaticValueResolution {
  const node = unwrap(asNode(value));
  if (!node) return unknownResolution();
  const literal = readLiteral(node);
  if (literal.found) return exactResolution(literal.value);
  if (node.type === 'Identifier') {
    if (readName(node) === 'undefined' && isUnbound(node, lexical)) {
      return exactResolution(undefined);
    }
    if (!lexical) return unknownResolution();
    const key = lexical.bindings.identifierKey(node);
    if (!key || resolving.has(key)) return unknownResolution();
    const resolved = lexical.resolveIdentifier(node);
    const values = resolved.values.map((candidate) =>
      resolveStaticValues(candidate, lexical, new Set(resolving).add(key))
    );
    return mergeResolutions(
      values,
      resolved.unknown ? unknownResolution() : undefined,
    );
  }
  if (node.type === 'ConditionalExpression') {
    const truth = evaluateStaticTruth(node.test, lexical, resolving);
    if (truth !== undefined) {
      return resolveStaticValues(
        truth ? node.consequent : node.alternate,
        lexical,
        resolving,
      );
    }
    return mergeResolutions([
      resolveStaticValues(node.consequent, lexical, new Set(resolving)),
      resolveStaticValues(node.alternate, lexical, new Set(resolving)),
    ]);
  }
  if (node.type === 'LogicalExpression') {
    return resolveLogical(node, lexical, resolving);
  }
  if (node.type === 'UnaryExpression') {
    if (node.operator === '!') {
      const truth = resolveTruthValues(
        resolveStaticValues(node.argument, lexical, resolving),
      );
      return {
        values: new Set([
          ...(truth.falsePossible ? [true] : []),
          ...(truth.truePossible ? [false] : []),
        ]),
        unknownFalsy: false,
        unknownTruthy: false,
      };
    }
    if (node.operator === 'void') return exactResolution(undefined);
  }
  if (node.type === 'BinaryExpression') {
    return resolveBinary(node, lexical, resolving);
  }
  if (node.type === 'SequenceExpression') {
    return resolveStaticValues(asNodes(node.expressions).at(-1), lexical, resolving);
  }
  if (node.type === 'TemplateLiteral' && asNodes(node.expressions).length === 0) {
    const quasi = asNodes(node.quasis)[0];
    const cooked = asNode(quasi?.value)?.cooked;
    return typeof cooked === 'string' ? exactResolution(cooked) : unknownResolution();
  }
  return unknownResolution();
}

export function evaluateStaticTruth(
  value: unknown,
  lexical?: MutationBoundaryLexicalValues,
  resolving = new Set<string>(),
): boolean | undefined {
  const truth = resolveTruthValues(resolveStaticValues(value, lexical, resolving));
  if (truth.truePossible === truth.falsePossible) return undefined;
  return truth.truePossible;
}

export function readExactStaticString(
  value: unknown,
  lexical?: MutationBoundaryLexicalValues,
): string {
  const resolved = resolveStaticValues(value, lexical);
  const strings = [...resolved.values].filter(
    (candidate): candidate is string => typeof candidate === 'string',
  );
  return strings.length === 1 && resolved.values.size === 1 &&
      !resolved.unknownFalsy && !resolved.unknownTruthy
    ? strings[0]
    : '';
}

export function resolveStaticPropertyKeys(
  value: unknown,
  lexical?: MutationBoundaryLexicalValues,
): StaticPropertyKeyResolution {
  const resolved = resolveStaticValues(value, lexical);
  const names = new Set(
    [...resolved.values].flatMap((candidate) =>
      typeof candidate === 'string' || typeof candidate === 'number' ? [String(candidate)] : []
    ),
  );
  return {
    names,
    unknown: resolved.unknownFalsy || resolved.unknownTruthy ||
      names.size !== resolved.values.size,
  };
}

function resolveLogical(
  node: AstNode,
  lexical: MutationBoundaryLexicalValues | undefined,
  resolving: Set<string>,
): StaticValueResolution {
  const left = resolveStaticValues(node.left, lexical, new Set(resolving));
  if (node.operator === '??') {
    const right = resolveStaticValues(node.right, lexical, new Set(resolving));
    const retained = [...left.values].filter(
      (candidate) => candidate !== null && candidate !== undefined,
    );
    const needsRight = retained.length !== left.values.size ||
      left.unknownFalsy || left.unknownTruthy;
    return mergeResolutions([
      resolutionFromValues(retained),
      needsRight ? right : undefined,
      left.unknownFalsy || left.unknownTruthy ? unknownResolution() : undefined,
    ]);
  }
  const truth = resolveTruthValues(left);
  const right = resolveStaticValues(node.right, lexical, new Set(resolving));
  if (node.operator === '&&') {
    return mergeResolutions([
      resolutionFromValues([...left.values].filter((candidate) => !candidate)),
      truth.truePossible ? right : undefined,
      left.unknownFalsy ? unknownFalsyResolution() : undefined,
    ]);
  }
  if (node.operator === '||') {
    return mergeResolutions([
      resolutionFromValues([...left.values].filter(Boolean)),
      truth.falsePossible ? right : undefined,
      left.unknownTruthy ? unknownTruthyResolution() : undefined,
    ]);
  }
  return unknownResolution();
}

function resolveBinary(
  node: AstNode,
  lexical: MutationBoundaryLexicalValues | undefined,
  resolving: Set<string>,
): StaticValueResolution {
  const left = resolveStaticValues(node.left, lexical, new Set(resolving));
  const right = resolveStaticValues(node.right, lexical, new Set(resolving));
  if (
    left.values.size !== 1 || right.values.size !== 1 ||
    left.unknownFalsy || left.unknownTruthy || right.unknownFalsy || right.unknownTruthy
  ) return unknownResolution();
  const leftValue = [...left.values][0];
  const rightValue = [...right.values][0];
  if (node.operator === '===' || node.operator === '==') {
    return exactResolution(leftValue === rightValue);
  }
  if (node.operator === '!==' || node.operator === '!=') {
    return exactResolution(leftValue !== rightValue);
  }
  return unknownResolution();
}

function mergeResolutions(
  resolutions: readonly (StaticValueResolution | undefined)[],
  additional?: StaticValueResolution,
): StaticValueResolution {
  const values = new Set<StaticPrimitive>();
  let unknownFalsy = false;
  let unknownTruthy = false;
  for (const resolution of [...resolutions, additional]) {
    if (!resolution) continue;
    for (const value of resolution.values) values.add(value);
    unknownFalsy = unknownFalsy || resolution.unknownFalsy;
    unknownTruthy = unknownTruthy || resolution.unknownTruthy;
  }
  return { values, unknownFalsy, unknownTruthy };
}

function resolveTruthValues(resolution: StaticValueResolution): {
  readonly falsePossible: boolean;
  readonly truePossible: boolean;
} {
  return {
    falsePossible: resolution.unknownFalsy || [...resolution.values].some((value) => !value),
    truePossible: resolution.unknownTruthy || [...resolution.values].some(Boolean),
  };
}

function readLiteral(node: AstNode): {
  readonly found: boolean;
  readonly value: StaticPrimitive;
} {
  if (node.type === 'BooleanLiteral' && typeof node.value === 'boolean') {
    return { found: true, value: node.value };
  }
  if (node.type === 'StringLiteral' && typeof node.value === 'string') {
    return { found: true, value: node.value };
  }
  if (node.type === 'NumericLiteral' && typeof node.value === 'number') {
    return { found: true, value: node.value };
  }
  if (node.type === 'NullLiteral') return { found: true, value: null };
  return { found: false, value: undefined };
}

function exactResolution(value: StaticPrimitive): StaticValueResolution {
  return { values: new Set([value]), unknownFalsy: false, unknownTruthy: false };
}

function resolutionFromValues(
  values: readonly StaticPrimitive[],
): StaticValueResolution | undefined {
  return values.length
    ? { values: new Set(values), unknownFalsy: false, unknownTruthy: false }
    : undefined;
}

function unknownResolution(): StaticValueResolution {
  return { values: new Set(), unknownFalsy: true, unknownTruthy: true };
}

function unknownFalsyResolution(): StaticValueResolution {
  return { values: new Set(), unknownFalsy: true, unknownTruthy: false };
}

function unknownTruthyResolution(): StaticValueResolution {
  return { values: new Set(), unknownFalsy: false, unknownTruthy: true };
}

function isUnbound(
  node: AstNode,
  lexical: MutationBoundaryLexicalValues | undefined,
): boolean {
  return !lexical || lexical.bindings.identifierKey(node) === `unbound:${readName(node)}`;
}

function unwrap(value: AstNode | undefined): AstNode | undefined {
  if (
    value?.type === 'TSAsExpression' || value?.type === 'TSTypeAssertion' ||
    value?.type === 'TypeCastExpression' || value?.type === 'TSNonNullExpression' ||
    value?.type === 'ParenthesizedExpression'
  ) return unwrap(asNode(value.expression));
  return value;
}

function readName(value: unknown): string {
  const node = asNode(value);
  return node && typeof node.name === 'string' ? node.name : '';
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}
