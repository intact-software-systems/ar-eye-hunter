import {
  asCapabilityNode as asNode,
  type MutationBoundaryCapabilityAstNode as AstNode,
  readCapabilityLiteralString as readLiteralString,
  readCapabilityName as readName,
  readCapabilityString as readString,
  unwrapCapabilityExpression as unwrapExpression,
} from './mutation-boundary-capability-ast.ts';
import type { CapabilityValueResolver } from './mutation-boundary-capability-values.ts';
import type { CapabilityTypeResolver } from './mutation-boundary-capability-types.ts';
import type { MutationBoundaryLexicalBindings } from './mutation-boundary-lexical-bindings.ts';
import type { FlowCapabilityMethod } from './mutation-boundary-capability-flow.ts';

export interface CapabilityBindingAnalysis {
  readonly resolver: CapabilityTypeResolver;
  readonly values: CapabilityValueResolver;
  readonly bindings: MutationBoundaryLexicalBindings;
  readonly receivers: Map<string, string>;
  readonly methods: Map<string, FlowCapabilityMethod>;
  readonly strings: Map<string, string>;
}

export function readDirectCapabilityMethod(
  value: unknown,
  analysis: CapabilityBindingAnalysis,
): FlowCapabilityMethod | undefined {
  const node = unwrapExpression(asNode(value));
  if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  const method = readCapabilityPropertyName(node.property, node.computed === true, analysis);
  const capability = analysis.receivers.get(capabilityExpressionKey(node.object, analysis));
  return capability && method ? { capability, method } : undefined;
}

export function readCapabilityMethod(
  value: unknown,
  analysis: CapabilityBindingAnalysis,
): FlowCapabilityMethod | undefined {
  const node = unwrapExpression(asNode(value));
  if (!node) return undefined;
  const existing = analysis.methods.get(capabilityExpressionKey(node, analysis));
  if (existing) return existing;
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  const capability = analysis.receivers.get(capabilityExpressionKey(node.object, analysis));
  const method = readCapabilityPropertyName(node.property, node.computed === true, analysis);
  return capability && method ? { capability, method } : undefined;
}

export function capabilityExpressionKey(
  value: unknown,
  analysis: CapabilityBindingAnalysis,
): string {
  const node = unwrapExpression(asNode(value));
  if (!node) return '';
  if (node.type === 'Identifier') return analysis.bindings.identifierKey(node);
  if (node.type === 'ThisExpression') return analysis.bindings.thisKey(node);
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return '';
  const object = capabilityExpressionKey(node.object, analysis);
  const property = readCapabilityPropertyName(node.property, node.computed === true, analysis);
  return object && property ? `${object}.${property}` : '';
}

export function readCapabilityPropertyName(
  value: unknown,
  computed: boolean,
  analysis: CapabilityBindingAnalysis,
): string {
  const node = asNode(value);
  if (!node) return '';
  if (node.type === 'StringLiteral') return readString(node);
  if (node.type === 'NumericLiteral' && typeof node.value === 'number') return String(node.value);
  if (node.type === 'PrivateName') return readName(node.id);
  if (node.type === 'Identifier') {
    return computed
      ? analysis.strings.get(analysis.bindings.identifierKey(node)) ?? ''
      : readName(node);
  }
  return readLiteralString(node);
}

export function isCapabilityFunction(node: AstNode): boolean {
  return [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
}

export function setCapability(
  map: Map<string, string>,
  key: string,
  value: string,
): boolean {
  if (!key || !value || map.get(key) === value) return false;
  map.set(key, value);
  return true;
}

export function setCapabilityMethod(
  methods: Map<string, FlowCapabilityMethod>,
  key: string,
  value: FlowCapabilityMethod,
): boolean {
  const current = methods.get(key);
  if (!key || current?.capability === value.capability && current.method === value.method) {
    return false;
  }
  methods.set(key, value);
  return true;
}
