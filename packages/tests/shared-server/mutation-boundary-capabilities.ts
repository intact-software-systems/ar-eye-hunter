import { parse } from '@babel/parser';
import { readCapabilityExports } from './mutation-boundary-capability-exports.ts';

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
  const imports = new Map<string, string>();
  const namespaces = new Map<string, ReadonlySet<string>>();
  const receivers = new Map<string, string>();
  const strings = new Map<string, string>();
  const calls = new Set<string>();
  walk(program, (node) => {
    if (node.type === 'ImportDeclaration') {
      readCapabilityImport(node, imports, namespaces);
    }
  });
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    walk(program, (node) => {
      changed = bindCapabilityNode(node, imports, namespaces, receivers, strings) || changed;
    });
    if (!changed) break;
  }
  walk(program, (node) => {
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const call = readCapabilityCall(node.callee, imports, namespaces, receivers, strings);
      if (call && !READ_ONLY_CAPABILITY_METHODS.get(call.capability)?.has(call.method)) {
        calls.add(`${call.capability}.${call.method}`);
      }
    }
  });
  return [...calls].toSorted();
}

function readCapabilityImport(
  node: AstNode,
  imports: Map<string, string>,
  namespaces: Map<string, ReadonlySet<string>>,
): void {
  const source = readString(node.source);
  const exported = readCapabilityExports(source);
  if (exported.size === 0) return;
  for (const specifier of asNodes(node.specifiers)) {
    const local = readName(specifier.local);
    if (specifier.type === 'ImportNamespaceSpecifier') {
      if (local) namespaces.set(local, exported);
      continue;
    }
    const imported = readName(specifier.imported);
    if (local && exported.has(imported)) imports.set(local, imported);
  }
}

function bindCapabilityNode(
  node: AstNode,
  imports: Map<string, string>,
  namespaces: Map<string, ReadonlySet<string>>,
  receivers: Map<string, string>,
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
      imports,
      namespaces,
      receivers,
    );
    return bindString(id, init, strings) || receiverChanged;
  }
  if (node.type === 'AssignmentExpression') {
    return bindPattern(
      asNode(node.left),
      undefined,
      asNode(node.right),
      '',
      imports,
      namespaces,
      receivers,
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
        imports,
        namespaces,
        receivers,
      ) || changed;
    }
    return changed;
  }
  if (
    node.type === 'ClassProperty' || node.type === 'ClassPrivateProperty' ||
    node.type === 'PropertyDefinition'
  ) {
    const name = readPropertyName(node.key, false, new Map());
    const capability = readCapabilityType(node.typeAnnotation, imports, namespaces);
    return name && capability ? setIfChanged(receivers, `this.${name}`, capability) : false;
  }
  return false;
}

function bindPattern(
  pattern: AstNode | undefined,
  typeAnnotation: unknown,
  value: AstNode | undefined,
  additionalPrefix: string,
  imports: Map<string, string>,
  namespaces: Map<string, ReadonlySet<string>>,
  receivers: Map<string, string>,
): boolean {
  if (!pattern) return false;
  if (pattern.type === 'MemberExpression' || pattern.type === 'OptionalMemberExpression') {
    const target = readExpressionPath(pattern);
    const source = readExpressionPath(value);
    const capability = receivers.get(source) ||
      readConstructedCapability(value, imports, namespaces);
    return target && capability ? setIfChanged(receivers, target, capability) : false;
  }
  if (pattern.type === 'Identifier') {
    const name = readName(pattern);
    const source = readExpressionPath(value);
    const capability = readCapabilityType(typeAnnotation, imports, namespaces) ||
      readConstructedCapability(value, imports, namespaces) || receivers.get(source) || '';
    let changed = capability ? setIfChanged(receivers, name, capability) : false;
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
      imports,
      namespaces,
      receivers,
    );
  }
  if (pattern.type !== 'ObjectPattern') return false;
  const memberTypes = readObjectCapabilityTypes(typeAnnotation, imports, namespaces);
  const source = readExpressionPath(value);
  let changed = false;
  for (const property of asNodes(pattern.properties)) {
    if (property.type !== 'ObjectProperty') continue;
    const propertyName = readPropertyName(property.key, property.computed === true, new Map());
    const target = asNode(property.value);
    const capability = memberTypes.get(propertyName) || receivers.get(`${source}.${propertyName}`);
    if (target?.type === 'Identifier' && capability) {
      changed = setIfChanged(receivers, readName(target), capability) || changed;
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

function readObjectCapabilityTypes(
  value: unknown,
  imports: Map<string, string>,
  namespaces: Map<string, ReadonlySet<string>>,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const node = unwrapType(value);
  if (node?.type !== 'TSTypeLiteral') return result;
  for (const member of asNodes(node.members)) {
    if (member.type !== 'TSPropertySignature') continue;
    const name = readPropertyName(member.key, member.computed === true, new Map());
    const capability = readCapabilityType(member.typeAnnotation, imports, namespaces);
    if (name && capability) result.set(name, capability);
  }
  return result;
}

function readCapabilityType(
  value: unknown,
  imports: Map<string, string>,
  namespaces: Map<string, ReadonlySet<string>>,
): string {
  const node = unwrapType(value);
  if (node?.type !== 'TSTypeReference') return '';
  const typeName = asNode(node.typeName);
  if (typeName?.type === 'Identifier') return imports.get(readName(typeName)) ?? '';
  if (typeName?.type !== 'TSQualifiedName') return '';
  const capability = readName(typeName.right);
  return namespaces.get(readName(typeName.left))?.has(capability) === true ? capability : '';
}

function readConstructedCapability(
  value: unknown,
  imports: Map<string, string>,
  namespaces: Map<string, ReadonlySet<string>>,
): string {
  const node = asNode(value);
  if (node?.type !== 'NewExpression') return '';
  const callee = asNode(node.callee);
  if (callee?.type === 'Identifier') return imports.get(readName(callee)) ?? '';
  if (callee?.type !== 'MemberExpression') return '';
  const capability = readName(callee.property);
  return namespaces.get(readName(callee.object))?.has(capability) === true ? capability : '';
}

function readCapabilityCall(
  value: unknown,
  imports: Map<string, string>,
  namespaces: Map<string, ReadonlySet<string>>,
  receivers: Map<string, string>,
  strings: Map<string, string>,
): Readonly<{ capability: string; method: string }> | undefined {
  const callee = asNode(value);
  if (callee?.type !== 'MemberExpression' && callee?.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  const method = readPropertyName(callee.property, callee.computed === true, strings);
  const object = asNode(callee.object);
  const capability = receivers.get(readExpressionPath(object)) ||
    readConstructedCapability(object, imports, namespaces);
  return capability && method ? { capability, method } : undefined;
}

function unwrapType(value: unknown): AstNode | undefined {
  let node = asNode(value);
  if (node?.type === 'TSTypeAnnotation') node = asNode(node.typeAnnotation);
  if (node?.type === 'TSTypeReference') {
    const typeName = asNode(node.typeName);
    const parameters = asNodes(
      (asNode(node.typeParameters) ?? asNode(node.typeArguments))?.params,
    );
    if (readName(typeName) === 'Readonly' && parameters[0]) return unwrapType(parameters[0]);
  }
  return node;
}

function readExpressionPath(value: unknown): string {
  const node = asNode(value);
  if (!node) return '';
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
