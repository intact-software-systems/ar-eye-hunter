export type MutationBoundaryCapabilityAstNode = {
  readonly type: string;
  readonly [key: string]: unknown;
};

export function unwrapCapabilityExpression(
  value: MutationBoundaryCapabilityAstNode | undefined,
): MutationBoundaryCapabilityAstNode | undefined {
  if (
    value?.type === 'TSAsExpression' || value?.type === 'TSTypeAssertion' ||
    value?.type === 'TypeCastExpression' || value?.type === 'TSNonNullExpression' ||
    value?.type === 'ParenthesizedExpression'
  ) return unwrapCapabilityExpression(asCapabilityNode(value.expression));
  return value;
}

export function readCapabilityLiteralString(value: unknown): string {
  const node = asCapabilityNode(value);
  if (!node) return '';
  if (node.type === 'StringLiteral') return readCapabilityString(node);
  if (node.type === 'TemplateLiteral' && asCapabilityNodes(node.expressions).length === 0) {
    return asCapabilityNodes(node.quasis).map((part) => {
      const cooked = asCapabilityNode(part.value);
      return cooked && typeof cooked.cooked === 'string' ? cooked.cooked : '';
    }).join('');
  }
  return '';
}

export function walkCapabilityAst(
  value: unknown,
  visit: (node: MutationBoundaryCapabilityAstNode) => void,
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkCapabilityAst(item, visit);
    return;
  }
  const node = value as MutationBoundaryCapabilityAstNode;
  if (typeof node.type === 'string') visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) {
      walkCapabilityAst(child, visit);
    }
  }
}

export function readCapabilityName(value: unknown): string {
  const node = asCapabilityNode(value);
  return node && typeof node.name === 'string' ? node.name : '';
}

export function readCapabilityString(value: unknown): string {
  const node = asCapabilityNode(value);
  return node && typeof node.value === 'string' ? node.value : '';
}

export function asCapabilityNode(
  value: unknown,
): MutationBoundaryCapabilityAstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as MutationBoundaryCapabilityAstNode
    : undefined;
}

export function asCapabilityNodes(
  value: unknown,
): readonly MutationBoundaryCapabilityAstNode[] {
  return Array.isArray(value)
    ? value.map(asCapabilityNode).filter(
      (node): node is MutationBoundaryCapabilityAstNode => node !== undefined,
    )
    : [];
}
