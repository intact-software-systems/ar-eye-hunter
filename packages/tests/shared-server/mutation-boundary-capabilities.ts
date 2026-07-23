import { parse } from '@babel/parser';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const READ_ONLY_CAPABILITY_METHODS = new Map<string, ReadonlySet<string>>([
  [
    'ClientStateRepository',
    new Set([
      'findInstance',
      'findPrincipal',
      'findSession',
      'findSessionsByPrincipal',
      'listAllSessions',
      'listInstances',
      'listPrincipals',
      'readSnapshot',
    ]),
  ],
]);

type AstNode = { readonly type: string; readonly [key: string]: unknown };
const capabilityExports = new Map<string, ReadonlySet<string>>();

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
  const calls = new Set<string>();
  walk(program, (node) => {
    if (node.type === 'ImportDeclaration') {
      readCapabilityImport(node, imports, namespaces);
    } else if (node.type === 'VariableDeclarator') {
      readCapabilityReceiver(node, imports, namespaces, receivers);
    } else if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const call = readCapabilityCall(node.callee, imports, namespaces, receivers);
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
  if (node.importKind === 'type') return;
  const source = readString(node.source);
  const exported = readCapabilityExports(source);
  if (exported.size === 0) return;
  for (const specifier of asNodes(node.specifiers)) {
    if (specifier.importKind === 'type') continue;
    const local = readName(specifier.local);
    if (specifier.type === 'ImportNamespaceSpecifier') {
      if (local) namespaces.set(local, exported);
      continue;
    }
    const imported = readName(specifier.imported);
    if (local && exported.has(imported)) imports.set(local, imported);
  }
}

function readCapabilityReceiver(
  node: AstNode,
  imports: Map<string, string>,
  namespaces: Map<string, ReadonlySet<string>>,
  receivers: Map<string, string>,
): void {
  const id = asNode(node.id);
  if (id?.type !== 'Identifier') return;
  const capability = readCapabilityType(id.typeAnnotation, imports, namespaces) ||
    readConstructedCapability(node.init, imports, namespaces);
  if (capability) receivers.set(readName(id), capability);
}

function readCapabilityType(
  value: unknown,
  imports: Map<string, string>,
  namespaces: Map<string, ReadonlySet<string>>,
): string {
  let node = asNode(value);
  if (node?.type === 'TSTypeAnnotation') node = asNode(node.typeAnnotation);
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
): Readonly<{ capability: string; method: string }> | undefined {
  const callee = asNode(value);
  if (callee?.type !== 'MemberExpression' && callee?.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  const method = readName(callee.property);
  const object = asNode(callee.object);
  if (object?.type === 'Identifier') {
    const capability = receivers.get(readName(object));
    return capability && method ? { capability, method } : undefined;
  }
  const capability = readConstructedCapability(object, imports, namespaces);
  return capability && method ? { capability, method } : undefined;
}

function isMutableCapability(name: string): boolean {
  return /(?:Repository|MutationService|ManagementService)$/u.test(name);
}

function readCapabilityExports(specifier: string): ReadonlySet<string> {
  const entry = specifier.startsWith('@shared-server/')
    ? `packages/shared-server/${specifier.slice('@shared-server/'.length)}`
    : specifier.endsWith('/shared-server/mod.ts')
    ? 'packages/shared-server/mod.ts'
    : '';
  return entry ? readCapabilityExportsFromFile(entry, new Set()) : new Set();
}

function readCapabilityExportsFromFile(
  filePath: string,
  visiting: Set<string>,
): ReadonlySet<string> {
  const normalized = filePath.split(path.sep).join('/');
  const cached = capabilityExports.get(normalized);
  if (cached) return cached;
  if (visiting.has(normalized) || !existsSync(normalized)) return new Set();
  visiting.add(normalized);
  const program = parse(readFileSync(normalized, 'utf8'), {
    sourceType: 'module',
    plugins: ['typescript', 'importAttributes'],
  }).program;
  const exports = new Set<string>();
  for (const statement of program.body as AstNode[]) {
    const declaration = asNode(statement.declaration);
    const declaredName = readName(declaration?.id);
    if (declaredName && isMutableCapability(declaredName)) exports.add(declaredName);
    const source = readString(statement.source);
    if (!source || !source.startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(normalized), source);
    const target = path.relative(process.cwd(), resolved).split(path.sep).join('/');
    for (const capability of readCapabilityExportsFromFile(target, visiting)) {
      exports.add(capability);
    }
  }
  visiting.delete(normalized);
  capabilityExports.set(normalized, exports);
  return exports;
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
