import { parse } from '@babel/parser';
import {
  type CapabilityTypeResolver,
  type CapabilityTypeShape,
  createCapabilityTypeResolver,
} from './mutation-boundary-capability-types.ts';

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

type AstNode = { readonly type: string; readonly [key: string]: unknown };

export function findCapabilityMutationCalls(
  source: string,
  filePath: string,
): readonly string[] {
  const program = parse(source, {
    sourceType: 'module',
    sourceFilename: filePath,
    plugins: ['typescript', 'importAttributes'],
  }).program;
  const resolver = createCapabilityTypeResolver(program as AstNode, filePath);
  const receivers = new Map<string, string>();
  const methods = new Map<string, Readonly<{ capability: string; method: string }>>();
  const strings = new Map<string, string>();
  const calls = new Set<string>();
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    walk(program, (node) => {
      changed = bindCapabilityNode(node, resolver, receivers, methods, strings) || changed;
    });
    if (!changed) break;
  }
  walk(program, (node) => {
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const call = readCapabilityCall(node.callee, receivers, methods, strings);
      if (call && !READ_ONLY_CAPABILITY_METHODS.get(call.capability)?.has(call.method)) {
        calls.add(`${call.capability}.${call.method}`);
      }
    }
  });
  return [...calls].toSorted();
}

function bindCapabilityNode(
  node: AstNode,
  resolver: CapabilityTypeResolver,
  receivers: Map<string, string>,
  methods: Map<string, Readonly<{ capability: string; method: string }>>,
  strings: Map<string, string>,
): boolean {
  if (node.type === 'VariableDeclarator') {
    const id = asNode(node.id);
    const init = asNode(node.init);
    const receiverChanged = bindPattern(
      id,
      id?.typeAnnotation,
      init,
      '',
      resolver,
      receivers,
      methods,
    );
    return bindString(id, init, strings) || receiverChanged;
  }
  if (node.type === 'AssignmentExpression') {
    return bindPattern(
      asNode(node.left),
      undefined,
      asNode(node.right),
      '',
      resolver,
      receivers,
      methods,
    );
  }
  if (isFunction(node)) {
    let changed = false;
    for (const parameter of asNodes(node.params)) {
      const parameterProperty = parameter.type === 'TSParameterProperty';
      const actual = parameterProperty ? asNode(parameter.parameter) : parameter;
      changed = bindPattern(
        actual,
        actual?.typeAnnotation,
        undefined,
        parameterProperty && node.type === 'ClassMethod' && node.kind === 'constructor'
          ? 'this.'
          : '',
        resolver,
        receivers,
        methods,
      ) || changed;
    }
    return changed;
  }
  if (
    node.type === 'ClassProperty' || node.type === 'ClassPrivateProperty' ||
    node.type === 'PropertyDefinition'
  ) {
    const name = readPropertyName(node.key, false, new Map());
    const shape = resolver.resolveType(node.typeAnnotation);
    return name && shape ? bindShape(receivers, `this.${name}`, shape) : false;
  }
  return false;
}

function bindPattern(
  pattern: AstNode | undefined,
  typeAnnotation: unknown,
  value: AstNode | undefined,
  additionalPrefix: string,
  resolver: CapabilityTypeResolver,
  receivers: Map<string, string>,
  methods: Map<string, Readonly<{ capability: string; method: string }>>,
): boolean {
  if (!pattern) return false;
  if (pattern.type === 'MemberExpression' || pattern.type === 'OptionalMemberExpression') {
    const target = readExpressionPath(pattern);
    const source = readExpressionPath(value);
    const shape = resolver.resolveExpression(value);
    const capability = receivers.get(source) || shape?.capability;
    let changed = target && capability ? setIfChanged(receivers, target, capability) : false;
    if (target && shape) changed = bindShape(receivers, target, shape) || changed;
    const method = methods.get(source);
    return target && method ? setMethodIfChanged(methods, target, method) || changed : changed;
  }
  if (pattern.type === 'Identifier') {
    const name = readName(pattern);
    const source = readExpressionPath(value);
    const shape = resolver.resolveType(typeAnnotation) ?? resolver.resolveExpression(value);
    const capability = shape?.capability || receivers.get(source) || '';
    let changed = capability ? setIfChanged(receivers, name, capability) : false;
    if (shape) changed = bindShape(receivers, name, shape) || changed;
    const method = methods.get(source);
    if (method) changed = setMethodIfChanged(methods, name, method) || changed;
    if (additionalPrefix && capability) {
      changed = setIfChanged(receivers, `${additionalPrefix}${name}`, capability) || changed;
    }
    if (value?.type === 'ObjectExpression') {
      for (const property of asNodes(value.properties)) {
        const propertyName = readPropertyName(property.key, property.computed === true, new Map());
        const propertySource = readExpressionPath(property.value);
        const nested = receivers.get(propertySource);
        if (propertyName && nested) {
          changed = setIfChanged(receivers, `${name}.${propertyName}`, nested) || changed;
        }
      }
    }
    return changed;
  }
  if (pattern.type === 'AssignmentPattern') {
    return bindPattern(
      asNode(pattern.left),
      asNode(pattern.left)?.typeAnnotation ?? typeAnnotation,
      asNode(pattern.right),
      additionalPrefix,
      resolver,
      receivers,
      methods,
    );
  }
  if (pattern.type !== 'ObjectPattern') return false;
  const shape = resolver.resolveType(typeAnnotation) ?? resolver.resolveExpression(value);
  const source = readExpressionPath(value);
  return bindObjectPattern(pattern, shape, source, receivers, methods);
}

function bindObjectPattern(
  pattern: AstNode,
  shape: CapabilityTypeShape | undefined,
  source: string,
  receivers: Map<string, string>,
  methods: Map<string, Readonly<{ capability: string; method: string }>>,
): boolean {
  const sourceCapability = receivers.get(source) ?? shape?.capability;
  let changed = false;
  for (const property of asNodes(pattern.properties)) {
    if (property.type !== 'ObjectProperty') continue;
    const propertyName = readPropertyName(property.key, property.computed === true, new Map());
    const rawTarget = asNode(property.value);
    const target = rawTarget?.type === 'AssignmentPattern' ? asNode(rawTarget.left) : rawTarget;
    const memberShape = shape?.members?.get(propertyName);
    const memberSource = source ? `${source}.${propertyName}` : '';
    const capability = memberShape?.capability || receivers.get(memberSource);
    if (target?.type === 'Identifier') {
      const targetName = readName(target);
      if (capability) changed = setIfChanged(receivers, targetName, capability) || changed;
      if (memberShape) changed = bindShape(receivers, targetName, memberShape) || changed;
      const method = methods.get(memberSource) ??
        (sourceCapability ? { capability: sourceCapability, method: propertyName } : undefined);
      if (method) changed = setMethodIfChanged(methods, targetName, method) || changed;
    } else if (target?.type === 'ObjectPattern') {
      changed = bindObjectPattern(target, memberShape, memberSource, receivers, methods) || changed;
    }
  }
  return changed;
}

function bindString(
  pattern: AstNode | undefined,
  value: AstNode | undefined,
  strings: Map<string, string>,
): boolean {
  if (pattern?.type !== 'Identifier') return false;
  const literal = readLiteralString(value) || strings.get(readExpressionPath(value)) || '';
  return literal ? setIfChanged(strings, readName(pattern), literal) : false;
}

function readCapabilityCall(
  value: unknown,
  receivers: Map<string, string>,
  methods: Map<string, Readonly<{ capability: string; method: string }>>,
  strings: Map<string, string>,
): Readonly<{ capability: string; method: string }> | undefined {
  const callee = asNode(value);
  if (callee?.type === 'Identifier') return methods.get(readName(callee));
  if (callee?.type !== 'MemberExpression' && callee?.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  const method = readPropertyName(callee.property, callee.computed === true, strings);
  const object = asNode(callee.object);
  const capability = receivers.get(readExpressionPath(object));
  return capability && method ? { capability, method } : undefined;
}

function readExpressionPath(value: unknown): string {
  const node = asNode(value);
  if (!node) return '';
  if (
    node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion' ||
    node.type === 'TypeCastExpression' || node.type === 'TSNonNullExpression' ||
    node.type === 'ParenthesizedExpression'
  ) {
    return readExpressionPath(node.expression);
  }
  if (node.type === 'Identifier' || node.type === 'ThisExpression') {
    return node.type === 'ThisExpression' ? 'this' : readName(node);
  }
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return '';
  const object = readExpressionPath(node.object);
  const property = readPropertyName(node.property, node.computed === true, new Map());
  return object && property ? `${object}.${property}` : '';
}

function readPropertyName(
  value: unknown,
  computed: boolean,
  strings: Map<string, string>,
): string {
  const node = asNode(value);
  if (!node) return '';
  if (node.type === 'StringLiteral') return readString(node);
  if (node.type === 'PrivateName') return readName(node.id);
  if (node.type === 'Identifier') {
    return computed ? strings.get(readName(node)) ?? '' : readName(node);
  }
  return readLiteralString(node);
}

function readLiteralString(value: unknown): string {
  const node = asNode(value);
  if (!node) return '';
  if (node.type === 'StringLiteral') return readString(node);
  if (node.type === 'TemplateLiteral' && asNodes(node.expressions).length === 0) {
    return asNodes(node.quasis).map((part) => {
      const cooked = asNode(part.value);
      return cooked && typeof cooked.cooked === 'string' ? cooked.cooked : '';
    }).join('');
  }
  return '';
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

function bindShape(
  receivers: Map<string, string>,
  prefix: string,
  shape: CapabilityTypeShape,
): boolean {
  let changed = shape.capability ? setIfChanged(receivers, prefix, shape.capability) : false;
  for (const [name, member] of shape.members ?? []) {
    changed = bindShape(receivers, `${prefix}.${name}`, member) || changed;
  }
  return changed;
}

function setMethodIfChanged(
  methods: Map<string, Readonly<{ capability: string; method: string }>>,
  key: string,
  value: Readonly<{ capability: string; method: string }>,
): boolean {
  const current = methods.get(key);
  if (
    !key ||
    current?.capability === value.capability && current.method === value.method
  ) {
    return false;
  }
  methods.set(key, value);
  return true;
}

function walk(value: unknown, visit: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) walk(child, visit);
  }
}

function readName(value: unknown): string {
  const node = asNode(value);
  return node && typeof node.name === 'string' ? node.name : '';
}

function readString(value: unknown): string {
  const node = asNode(value);
  return node && typeof node.value === 'string' ? node.value : '';
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}
