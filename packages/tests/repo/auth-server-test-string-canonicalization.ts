import {
  type AuthTestAstNode,
  readAstNode,
  readAstNodes,
  readAstString,
} from './auth-server-test-ast.ts';

type CanonicalizeAuthTestValue = (node: AuthTestAstNode) => unknown;

export function toAuthTestInterpolatedString(
  node: AuthTestAstNode,
  canonicalize: CanonicalizeAuthTestValue,
): unknown {
  const parts: unknown[] = [];
  appendStringParts(node, parts, canonicalize);
  return { type: 'InterpolatedString', parts: parts.filter((part) => !isEmptyTextPart(part)) };
}

export function isAuthTestInterpolatedString(node: AuthTestAstNode): boolean {
  if (node.type === 'TemplateLiteral') return true;
  if (node.type !== 'BinaryExpression' || readAstString(node, 'operator') !== '+') return false;
  const left = readAstNode(node, 'left');
  const right = readAstNode(node, 'right');
  return Boolean(
    (left && (left.type === 'StringLiteral' || isAuthTestInterpolatedString(left))) ||
    (right && (right.type === 'StringLiteral' || isAuthTestInterpolatedString(right))),
  );
}

function appendStringParts(
  node: AuthTestAstNode,
  parts: unknown[],
  canonicalize: CanonicalizeAuthTestValue,
): void {
  if (node.type === 'StringLiteral') {
    parts.push({ text: readAstString(node, 'value') ?? '' });
    return;
  }
  if (node.type === 'TemplateLiteral') {
    appendTemplateParts(node, parts, canonicalize);
    return;
  }
  if (node.type === 'BinaryExpression' && readAstString(node, 'operator') === '+') {
    const left = readAstNode(node, 'left');
    const right = readAstNode(node, 'right');
    if (left !== undefined) appendStringParts(left, parts, canonicalize);
    if (right !== undefined) appendStringParts(right, parts, canonicalize);
    return;
  }
  parts.push({ expression: canonicalize(node) });
}

function appendTemplateParts(
  node: AuthTestAstNode,
  parts: unknown[],
  canonicalize: CanonicalizeAuthTestValue,
): void {
  const quasis = readAstNodes(node, 'quasis');
  const expressions = readAstNodes(node, 'expressions');
  quasis.forEach((quasi, index) => {
    parts.push({ text: readTemplateText(quasi) });
    const expression = expressions[index];
    if (expression !== undefined) parts.push({ expression: canonicalize(expression) });
  });
}

function readTemplateText(node: AuthTestAstNode): string {
  const value = node.value;
  if (typeof value !== 'object' || value === null) return '';
  const template = value as { readonly cooked?: unknown; readonly raw?: unknown };
  if (typeof template.cooked === 'string') return template.cooked;
  return typeof template.raw === 'string' ? template.raw : '';
}

function isEmptyTextPart(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { text?: unknown }).text === '';
}
