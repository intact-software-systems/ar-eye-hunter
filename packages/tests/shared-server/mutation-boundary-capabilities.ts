import { parse } from '@babel/parser';

import {
  asCapabilityNode as asNode,
  asCapabilityNodes as asNodes,
  type MutationBoundaryCapabilityAstNode as AstNode,
  readCapabilityLiteralString as readLiteralString,
  readCapabilityName as readName,
  readCapabilityString as readString,
  unwrapCapabilityExpression as unwrapExpression,
  walkCapabilityAst as walk,
} from './mutation-boundary-capability-ast.ts';
import {
  type CapabilityTypeResolver,
  type CapabilityTypeShape,
  createCapabilityTypeResolver,
} from './mutation-boundary-capability-types.ts';
import {
  createMutationBoundaryLexicalBindings,
  type MutationBoundaryLexicalBindings,
} from './mutation-boundary-lexical-bindings.ts';

const READ_ONLY_CAPABILITY_METHODS = new Map<string, ReadonlySet<string>>([
  [
    'ClientStateRepository',
    new Set([
      'findInstance',
      'findPrincipal',
      'findSession',
      'findSessionEntry',
      'listEvents',
      'listRecentEvents',
      'listEventPage',
      'listAllSessions',
      'listInstances',
      'listPrincipals',
      'listSessions',
      'listSessionsForPrincipal',
      'listSnapshots',
      'readPresenceSnapshot',
      'readSnapshot',
    ]),
  ],
]);

type CapabilityMethod = Readonly<{ capability: string; method: string }>;

interface CapabilityAnalysis {
  readonly resolver: CapabilityTypeResolver;
  readonly bindings: MutationBoundaryLexicalBindings;
  readonly receivers: Map<string, string>;
  readonly methods: Map<string, CapabilityMethod>;
  readonly strings: Map<string, string>;
}

export function findCapabilityMutationCalls(
  source: string,
  filePath: string,
): readonly string[] {
  const program = parse(source, {
    sourceType: 'module',
    sourceFilename: filePath,
    plugins: ['typescript', 'importAttributes'],
  }).program as AstNode;
  const analysis: CapabilityAnalysis = {
    resolver: createCapabilityTypeResolver(program, filePath),
    bindings: createMutationBoundaryLexicalBindings(program),
    receivers: new Map(),
    methods: new Map(),
    strings: new Map(),
  };
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    walk(program, (node) => {
      changed = bindCapabilityNode(node, analysis) || changed;
    });
    if (!changed) break;
  }
  const calls = new Set<string>();
  walk(program, (node) => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    const call = readCapabilityCall(node.callee, analysis);
    if (call && !READ_ONLY_CAPABILITY_METHODS.get(call.capability)?.has(call.method)) {
      calls.add(`${call.capability}.${call.method}`);
    }
  });
  return [...calls].toSorted();
}

function bindCapabilityNode(node: AstNode, analysis: CapabilityAnalysis): boolean {
  if (node.type === 'VariableDeclarator') {
    const id = asNode(node.id);
    const init = asNode(node.init);
    return bindString(id, init, analysis) ||
      bindPattern(id, id?.typeAnnotation, init, analysis);
  }
  if (node.type === 'AssignmentExpression') {
    return bindPattern(asNode(node.left), undefined, asNode(node.right), analysis);
  }
  if (isFunction(node)) return bindFunctionParameters(node, analysis);
  if (
    node.type === 'ClassProperty' || node.type === 'ClassPrivateProperty' ||
    node.type === 'PropertyDefinition'
  ) {
    return bindClassProperty(node, analysis);
  }
  return false;
}

function bindFunctionParameters(node: AstNode, analysis: CapabilityAnalysis): boolean {
  let changed = false;
  for (const parameter of asNodes(node.params)) {
    const parameterProperty = parameter.type === 'TSParameterProperty';
    const actual = parameterProperty ? asNode(parameter.parameter) : parameter;
    changed = bindPattern(actual, actual?.typeAnnotation, undefined, analysis) || changed;
    if (
      parameterProperty && node.type === 'ClassMethod' && node.kind === 'constructor' &&
      actual?.type === 'Identifier'
    ) {
      const thisKey = analysis.bindings.thisKey(node);
      const sourceKey = analysis.bindings.identifierKey(actual);
      const targetKey = thisKey ? `${thisKey}.${readName(actual)}` : '';
      changed = copyProvenance(targetKey, sourceKey, analysis) || changed;
    }
  }
  return changed;
}

function bindClassProperty(node: AstNode, analysis: CapabilityAnalysis): boolean {
  const name = readPropertyName(node.key, false, analysis);
  const thisKey = analysis.bindings.thisKey(node);
  const targetKey = thisKey && name ? `${thisKey}.${name}` : '';
  if (!targetKey) return false;
  const value = asNode(node.value);
  const shape = analysis.resolver.resolveType(node.typeAnnotation) ??
    analysis.resolver.resolveExpression(value);
  const sourceKey = expressionKey(value, analysis);
  let changed = bindValueProvenance(targetKey, sourceKey, shape, value, analysis);
  if (shape) changed = bindShape(targetKey, shape, analysis) || changed;
  return changed;
}

function bindPattern(
  pattern: AstNode | undefined,
  typeAnnotation: unknown,
  value: AstNode | undefined,
  analysis: CapabilityAnalysis,
): boolean {
  if (!pattern) return false;
  if (pattern.type === 'MemberExpression' || pattern.type === 'OptionalMemberExpression') {
    const targetKey = expressionKey(pattern, analysis);
    const sourceKey = expressionKey(value, analysis);
    const shape = analysis.resolver.resolveExpression(value);
    return bindValueProvenance(targetKey, sourceKey, shape, value, analysis);
  }
  if (pattern.type === 'Identifier') {
    const targetKey = analysis.bindings.identifierKey(pattern);
    const sourceKey = expressionKey(value, analysis);
    const shape = analysis.resolver.resolveType(typeAnnotation) ??
      analysis.resolver.resolveExpression(value);
    let changed = bindValueProvenance(targetKey, sourceKey, shape, value, analysis);
    if (value?.type === 'ObjectExpression') {
      changed = bindObjectExpression(targetKey, value, analysis) || changed;
    }
    return changed;
  }
  if (pattern.type === 'AssignmentPattern') {
    return bindPattern(
      asNode(pattern.left),
      asNode(pattern.left)?.typeAnnotation ?? typeAnnotation,
      asNode(pattern.right),
      analysis,
    );
  }
  if (pattern.type !== 'ObjectPattern') return false;
  const shape = analysis.resolver.resolveType(typeAnnotation) ??
    analysis.resolver.resolveExpression(value);
  return bindObjectPattern(pattern, shape, expressionKey(value, analysis), analysis);
}

function bindValueProvenance(
  targetKey: string,
  sourceKey: string,
  shape: CapabilityTypeShape | undefined,
  value: AstNode | undefined,
  analysis: CapabilityAnalysis,
): boolean {
  if (!targetKey) return false;
  const capability = shape?.capability ?? analysis.receivers.get(sourceKey);
  let changed = capability ? setIfChanged(analysis.receivers, targetKey, capability) : false;
  if (shape) changed = bindShape(targetKey, shape, analysis) || changed;
  const method = readMethodReference(value, analysis) ?? analysis.methods.get(sourceKey);
  if (method) changed = setMethodIfChanged(analysis.methods, targetKey, method) || changed;
  return changed;
}

function bindObjectExpression(
  targetKey: string,
  value: AstNode,
  analysis: CapabilityAnalysis,
): boolean {
  let changed = false;
  for (const property of asNodes(value.properties)) {
    const name = readPropertyName(property.key, property.computed === true, analysis);
    const memberValue = asNode(property.value);
    if (!name || !memberValue) continue;
    const memberTarget = `${targetKey}.${name}`;
    changed = bindValueProvenance(
      memberTarget,
      expressionKey(memberValue, analysis),
      analysis.resolver.resolveExpression(memberValue),
      memberValue,
      analysis,
    ) || changed;
  }
  return changed;
}

function bindObjectPattern(
  pattern: AstNode,
  shape: CapabilityTypeShape | undefined,
  sourceKey: string,
  analysis: CapabilityAnalysis,
): boolean {
  const sourceCapability = analysis.receivers.get(sourceKey) ?? shape?.capability;
  let changed = false;
  for (const property of asNodes(pattern.properties)) {
    if (property.type !== 'ObjectProperty') continue;
    const name = readPropertyName(property.key, property.computed === true, analysis);
    const rawTarget = asNode(property.value);
    const target = rawTarget?.type === 'AssignmentPattern' ? asNode(rawTarget.left) : rawTarget;
    const memberShape = shape?.members?.get(name);
    const memberSource = sourceKey ? `${sourceKey}.${name}` : '';
    if (target?.type === 'Identifier') {
      const targetKey = analysis.bindings.identifierKey(target);
      changed = bindValueProvenance(targetKey, memberSource, memberShape, undefined, analysis) ||
        changed;
      const method = analysis.methods.get(memberSource) ??
        (sourceCapability ? { capability: sourceCapability, method: name } : undefined);
      if (method) changed = setMethodIfChanged(analysis.methods, targetKey, method) || changed;
    } else if (target?.type === 'ObjectPattern') {
      changed = bindObjectPattern(target, memberShape, memberSource, analysis) || changed;
    }
  }
  return changed;
}

function bindShape(
  targetKey: string,
  shape: CapabilityTypeShape,
  analysis: CapabilityAnalysis,
): boolean {
  let changed = shape.capability
    ? setIfChanged(analysis.receivers, targetKey, shape.capability)
    : false;
  for (const [name, member] of shape.members ?? []) {
    changed = bindShape(`${targetKey}.${name}`, member, analysis) || changed;
  }
  return changed;
}

function copyProvenance(
  targetKey: string,
  sourceKey: string,
  analysis: CapabilityAnalysis,
): boolean {
  if (!targetKey || !sourceKey) return false;
  let changed = false;
  const capability = analysis.receivers.get(sourceKey);
  if (capability) changed = setIfChanged(analysis.receivers, targetKey, capability);
  const method = analysis.methods.get(sourceKey);
  return method ? setMethodIfChanged(analysis.methods, targetKey, method) || changed : changed;
}

function bindString(
  pattern: AstNode | undefined,
  value: AstNode | undefined,
  analysis: CapabilityAnalysis,
): boolean {
  if (pattern?.type !== 'Identifier') return false;
  const literal = readLiteralString(value) ||
    analysis.strings.get(expressionKey(value, analysis)) || '';
  return literal
    ? setIfChanged(analysis.strings, analysis.bindings.identifierKey(pattern), literal)
    : false;
}

function readCapabilityCall(
  value: unknown,
  analysis: CapabilityAnalysis,
): CapabilityMethod | undefined {
  const callee = unwrapExpression(asNode(value));
  if (callee?.type === 'Identifier') {
    return analysis.methods.get(analysis.bindings.identifierKey(callee));
  }
  if (callee?.type !== 'MemberExpression' && callee?.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  const method = readPropertyName(callee.property, callee.computed === true, analysis);
  const capability = analysis.receivers.get(expressionKey(callee.object, analysis));
  return capability && method ? { capability, method } : undefined;
}

function readMethodReference(
  value: unknown,
  analysis: CapabilityAnalysis,
): CapabilityMethod | undefined {
  const node = unwrapExpression(asNode(value));
  if (!node) return undefined;
  const existing = analysis.methods.get(expressionKey(node, analysis));
  if (existing) return existing;
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  const capability = analysis.receivers.get(expressionKey(node.object, analysis));
  const method = readPropertyName(node.property, node.computed === true, analysis);
  return capability && method ? { capability, method } : undefined;
}

function expressionKey(value: unknown, analysis: CapabilityAnalysis): string {
  const node = unwrapExpression(asNode(value));
  if (!node) return '';
  if (node.type === 'Identifier') return analysis.bindings.identifierKey(node);
  if (node.type === 'ThisExpression') return analysis.bindings.thisKey(node);
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return '';
  const object = expressionKey(node.object, analysis);
  const property = readPropertyName(node.property, node.computed === true, analysis);
  return object && property ? `${object}.${property}` : '';
}

function readPropertyName(
  value: unknown,
  computed: boolean,
  analysis: CapabilityAnalysis,
): string {
  const node = asNode(value);
  if (!node) return '';
  if (node.type === 'StringLiteral') return readString(node);
  if (node.type === 'PrivateName') return readName(node.id);
  if (node.type === 'Identifier') {
    return computed
      ? analysis.strings.get(analysis.bindings.identifierKey(node)) ?? ''
      : readName(node);
  }
  return readLiteralString(node);
}

function isFunction(node: AstNode): boolean {
  return [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
}

function setIfChanged(map: Map<string, string>, key: string, value: string): boolean {
  if (!key || !value || map.get(key) === value) return false;
  map.set(key, value);
  return true;
}

function setMethodIfChanged(
  methods: Map<string, CapabilityMethod>,
  key: string,
  value: CapabilityMethod,
): boolean {
  const current = methods.get(key);
  if (!key || current?.capability === value.capability && current.method === value.method) {
    return false;
  }
  methods.set(key, value);
  return true;
}
