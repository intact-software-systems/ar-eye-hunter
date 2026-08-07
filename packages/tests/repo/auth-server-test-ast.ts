import { parse } from '@babel/parser';

export interface AuthTestAstNode {
  readonly type: string;
  readonly start?: number | null;
  readonly end?: number | null;
  readonly [key: string]: unknown;
}

interface AuthTestAstToken {
  readonly type: { readonly label?: string } | string;
  readonly value?: unknown;
  readonly start: number;
  readonly end: number;
}

export interface ParsedAuthTestSource {
  readonly root: AuthTestAstNode;
  readonly tokens: readonly AuthTestAstToken[];
}

interface BabelParseResult extends AuthTestAstNode {
  readonly errors?: readonly Error[];
  readonly tokens?: readonly AuthTestAstToken[];
}

export function parseAuthTestSource(
  ownerPath: string,
  source: string,
): { readonly parsed?: ParsedAuthTestSource; readonly issues: readonly string[] } {
  try {
    const plugins: ('jsx' | 'typescript')[] = ['typescript'];
    if (ownerPath.endsWith('.tsx') || ownerPath.endsWith('.jsx')) plugins.push('jsx');
    const root = parse(source, {
      sourceType: 'module',
      errorRecovery: true,
      plugins,
      tokens: true,
    }) as unknown as BabelParseResult;
    const issues = (root.errors ?? []).map((error) => `source.parse:${ownerPath}:${error.message}`);
    return issues.length === 0
      ? { parsed: { root, tokens: root.tokens ?? [] }, issues }
      : { issues };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { issues: [`source.parse:${ownerPath}:${message}`] };
  }
}

export function visitAuthTestAst(
  node: AuthTestAstNode,
  visit: (node: AuthTestAstNode, parent: AuthTestAstNode | undefined) => void,
): void {
  descend(node, undefined);

  function descend(current: AuthTestAstNode, parent: AuthTestAstNode | undefined): void {
    visit(current, parent);
    for (const child of readAstChildren(current)) descend(child, current);
  }
}

export function readAstChildren(node: AuthTestAstNode): readonly AuthTestAstNode[] {
  const children: AuthTestAstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (ignoredAstKeys.has(key)) continue;
    if (isAuthTestAstNode(value)) children.push(value);
    if (Array.isArray(value)) {
      children.push(...value.filter(isAuthTestAstNode));
    }
  }
  return children;
}

const ignoredAstKeys = new Set([
  'comments',
  'end',
  'errors',
  'extra',
  'innerComments',
  'leadingComments',
  'loc',
  'start',
  'tokens',
  'trailingComments',
]);

export function isAuthTestAstNode(value: unknown): value is AuthTestAstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly type?: unknown }).type === 'string'
  );
}

export function readAstNode(node: AuthTestAstNode, property: string): AuthTestAstNode | undefined {
  const value = node[property];
  return isAuthTestAstNode(value) ? value : undefined;
}

export function readAstNodes(node: AuthTestAstNode, property: string): readonly AuthTestAstNode[] {
  const value = node[property];
  return Array.isArray(value) ? value.filter(isAuthTestAstNode) : [];
}

export function readAstString(node: AuthTestAstNode, property: string): string | undefined {
  const value = node[property];
  return typeof value === 'string' ? value : undefined;
}

export function toCanonicalAst(node: AuthTestAstNode, _parsed: ParsedAuthTestSource): string {
  return JSON.stringify(toCanonicalAstValue(node));
}

function toCanonicalAstValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCanonicalAstValue);
  if (typeof value !== 'object' || value === null) return value;
  if (isAuthTestAstNode(value) && value.type === 'ParenthesizedExpression') {
    return toCanonicalAstValue(readAstNode(value, 'expression'));
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => !ignoredAstKeys.has(key) && entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, toCanonicalAstValue(entry)]),
  );
}
