import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import {
  findAstNode,
  findRouteRegistration,
  type MutationRoutingAstNode,
} from './mutation-routing-call-graph.ts';
import { findMutationRouteReachabilityIssues } from './mutation-routing-reachability.ts';
import {
  MUTATION_ROUTE_INVENTORY_ROWS,
  MUTATION_ROUTE_OWNER_PATHS,
} from './mutation-routing-owner-inventory.ts';

export interface MutationRouteInventoryEntry {
  readonly transport: 'HTTP' | 'WS_INBOX' | 'WS_LIFECYCLE' | 'MAINTENANCE';
  readonly entrypoint: string;
  readonly type: AppInboxType;
  readonly owner: string;
  readonly sourcePath: string;
  readonly registrationMarker: string;
  readonly enqueueSourcePath: string;
  readonly enqueueMarker: string;
  readonly ownerSourcePath: string;
  readonly typeOwnerSourcePath: string;
  readonly dispatchSourcePath: string;
}

const PATHS = {
  c: 'apps/api-v1/src/routes/client-state-routes.ts',
  g: 'apps/api-v1/src/routes/group-state-routes.ts',
  t: 'apps/api-v1/src/routes/graph-topology-routes.ts',
  a: 'apps/api-v1/src/routes/config-route.ts',
  w: 'apps/api-v1/src/routes/ws-routes.ts',
  ad: 'apps/api-v1/src/routes/admin-operations-routes.ts',
  cr: 'apps/api-v1/src/routes/crdt-admin-routes.ts',
  ag: 'apps/api-v1/src/services/create-api-admin-mutation-gateway.ts',
  rq: 'apps/api-v1/src/services/request-auth-service.ts',
  l: 'packages/shared-server/rallar-system/services/ws-lifecycle-service.ts',
  e: 'packages/shared-server/rallar-system/group-state/presence/reconcile-expired-group-presence.ts',
  s: 'packages/shared-server/rallar-system/ws-system-topics.ts',
  d: 'packages/shared-server/crdt/RallarCrdtServer.ts',
} as const;

export const MUTATION_ROUTE_INVENTORY: readonly MutationRouteInventoryEntry[] = decodeInventory(
  MUTATION_ROUTE_INVENTORY_ROWS,
);

export interface MutationRouteValidationOptions {
  readonly sourceOverrides?: ReadonlyMap<string, string>;
}

export function validateMutationRouteInventory(
  inventory: readonly MutationRouteInventoryEntry[],
  options: MutationRouteValidationOptions = {},
): readonly string[] {
  const issues: string[] = [];
  const sources = createSourceReader(options);
  if (inventory.length !== 50) issues.push(`Expected 50 entrypoints, found ${inventory.length}`);
  if (new Set(inventory.map((item) => item.type)).size !== 46) {
    issues.push('Inventory must cover all 46 AppInbox command types');
  }
  const seen = new Set<string>();
  for (const item of inventory) {
    const itemKey = key(item);
    if (seen.has(itemKey)) issues.push(`Duplicate mutation route: ${itemKey}`);
    seen.add(itemKey);
  }
  const canonicalByKey = new Map(MUTATION_ROUTE_INVENTORY.map((item) => [key(item), item]));
  for (const item of inventory) {
    const canonical = canonicalByKey.get(key(item));
    if (!canonical) {
      issues.push(`Unknown mutation route: ${key(item)}`);
      continue;
    }
    for (const field of [
      'owner',
      'sourcePath',
      'registrationMarker',
      'enqueueSourcePath',
      'enqueueMarker',
      'ownerSourcePath',
      'typeOwnerSourcePath',
      'dispatchSourcePath',
    ] as const) {
      if (item[field] !== canonical[field]) issues.push(`${key(item)} has incorrect ${field}`);
    }
    checkRegistration(issues, item, sources);
    checkAstMarker(issues, item.enqueueSourcePath, item.enqueueMarker, 'enqueue', item, sources);
    checkAstMarker(
      issues,
      item.typeOwnerSourcePath,
      `AppInboxType.${item.type}`,
      'type ownership',
      item,
      sources,
    );
    checkOwnerMethod(issues, item, sources);
    checkRegisteredHandlerCallChain(issues, item, sources);
  }
  return issues;
}

function decodeInventory(rows: string): readonly MutationRouteInventoryEntry[] {
  return rows
    .trim()
    .split('\n')
    .map((row) => {
      const [
        transport,
        entrypoint,
        type,
        source,
        registrationMarker,
        enqueueSource,
        enqueueMarker,
        ownerSource,
        owner,
        typeOwnerSource,
        dispatchSource,
      ] = row.split('\t');
      const sourcePath = PATHS[source as keyof typeof PATHS];
      const enqueueSourcePath = PATHS[enqueueSource as keyof typeof PATHS];
      const ownerSourcePath =
        MUTATION_ROUTE_OWNER_PATHS[ownerSource as keyof typeof MUTATION_ROUTE_OWNER_PATHS];
      const typeOwnerSourcePath = typeOwnerSource
        ? MUTATION_ROUTE_OWNER_PATHS[typeOwnerSource as keyof typeof MUTATION_ROUTE_OWNER_PATHS]
        : ownerSourcePath;
      const dispatchSourcePath = dispatchSource
        ? MUTATION_ROUTE_OWNER_PATHS[dispatchSource as keyof typeof MUTATION_ROUTE_OWNER_PATHS]
        : ownerSourcePath;
      const appInboxType = AppInboxType[type as keyof typeof AppInboxType];
      if (
        !sourcePath ||
        !enqueueSourcePath ||
        !ownerSourcePath ||
        !typeOwnerSourcePath ||
        !dispatchSourcePath ||
        !appInboxType
      ) {
        throw new Error(`Invalid mutation route inventory row: ${row}`);
      }
      return {
        transport: transport as MutationRouteInventoryEntry['transport'],
        entrypoint,
        type: appInboxType,
        owner,
        sourcePath,
        registrationMarker,
        enqueueSourcePath,
        enqueueMarker,
        ownerSourcePath,
        typeOwnerSourcePath,
        dispatchSourcePath,
      };
    });
}

function key(item: MutationRouteInventoryEntry): string {
  return `${item.transport}:${item.entrypoint}:${item.type}`;
}
function checkRegistration(
  issues: string[],
  item: MutationRouteInventoryEntry,
  sources: SourceReader,
): void {
  if (item.transport !== 'HTTP') {
    checkAstMarker(issues, item.sourcePath, item.registrationMarker, 'registration', item, sources);
    return;
  }
  const [method, rawPath] = item.entrypoint.split(' ');
  const routePath = rawPath;
  const program = sources.readProgram(issues, item.sourcePath, 'registration', item);
  if (!program) return;
  if (!hasRouteRegistration(program, method.toLowerCase(), routePath)) {
    issues.push(`${key(item)} registration is absent from ${item.sourcePath}`);
  }
}

function checkAstMarker(
  issues: string[],
  filePath: string,
  marker: string,
  label: string,
  item: MutationRouteInventoryEntry,
  sources: SourceReader,
): void {
  const program = sources.readProgram(issues, filePath, label, item);
  if (program && !hasExactMarker(program, marker)) {
    issues.push(`${key(item)} ${label} marker is absent from ${filePath}`);
  }
}
function checkOwnerMethod(
  issues: string[],
  item: MutationRouteInventoryEntry,
  sources: SourceReader,
): void {
  const method = item.owner.split('.').at(-1) ?? '';
  const program = sources.readProgram(issues, item.ownerSourcePath, 'owner', item);
  if (program && !hasOwnerCallable(program, method)) {
    issues.push(`${key(item)} owner method is absent from ${item.ownerSourcePath}`);
  }
}

type AstNode = MutationRoutingAstNode;

interface SourceReader {
  readProgram(
    issues: string[],
    filePath: string,
    label: string,
    item: MutationRouteInventoryEntry,
  ): AstNode | undefined;
}

function createSourceReader(options: MutationRouteValidationOptions): SourceReader {
  const cache = new Map<string, AstNode>();
  return {
    readProgram: (issues, filePath, label, item) => {
      const cached = cache.get(filePath);
      if (cached) return cached;
      try {
        const source = options.sourceOverrides?.get(filePath) ?? readFileSync(filePath, 'utf8');
        const program = parse(source, {
          sourceType: 'module',
          sourceFilename: filePath,
          plugins: ['typescript', 'importAttributes'],
        }).program as AstNode;
        cache.set(filePath, program);
        return program;
      } catch {
        issues.push(`${key(item)} ${label} source cannot be parsed: ${filePath}`);
        return undefined;
      }
    },
  };
}
function checkRegisteredHandlerCallChain(
  issues: string[],
  item: MutationRouteInventoryEntry,
  sources: SourceReader,
): void {
  const source = sources.readProgram(issues, item.sourcePath, 'call chain', item);
  const enqueue = sources.readProgram(issues, item.enqueueSourcePath, 'call chain', item);
  const owner = sources.readProgram(issues, item.ownerSourcePath, 'owner', item);
  const dispatch = sources.readProgram(issues, item.dispatchSourcePath, 'owner dispatch', item);
  if (!source || !enqueue || !owner || !dispatch) return;
  issues.push(
    ...findMutationRouteReachabilityIssues(
      item,
      source,
      enqueue,
      owner,
      dispatch,
      hasExactMarker,
      hasDirectExactMarker,
      (filePath) => sources.readProgram(issues, filePath, 'owner dependency', item),
    ),
  );
}

function hasRouteRegistration(program: AstNode, method: string, routePath: string): boolean {
  return findRouteRegistration(program, method, routePath) !== undefined;
}

function hasExactMarker(program: AstNode, marker: string): boolean {
  return someNode(program, (node) => hasDirectExactMarker(node, marker));
}

function hasDirectExactMarker(program: AstNode, marker: string): boolean {
  const member = marker.match(/^(\w+)\.(\w+)$/);
  if (member) {
    const memberPath = readMemberPath(program);
    return memberPath === marker || memberPath.endsWith(`.${marker}`);
  }
  const quoted = marker.match(/^'([^']+)'$/);
  if (quoted) return readString(program) === quoted[1];
  const comparison = marker.match(/^(\w+) === '([^']+)'$/);
  if (comparison) {
    return (
      program.type === 'BinaryExpression' &&
      program.operator === '===' &&
      readIdentifier(asNode(program.left)) === comparison[1] &&
      readString(asNode(program.right)) === comparison[2]
    );
  }
  const call = marker.match(/^(?:(\w+)\.)?(\w+)\((?:[^']*'([^']+)')?/);
  if (call) {
    if (program.type !== 'CallExpression') return false;
    const callee = asNode(program.callee);
    if (readCallName(callee) !== call[2]) return false;
    if (call[1] && readIdentifier(asNode(callee?.object)) !== call[1]) return false;
    return (
      !call[3] || asNodes(program.arguments).some((argument) => readString(argument) === call[3])
    );
  }
  const property = marker.replace(/:$/, '');
  return (
    readIdentifier(program) === property ||
    readMemberName(program) === property ||
    ((program.type === 'ObjectProperty' || program.type === 'ObjectMethod') &&
      readIdentifier(asNode(program.key)) === property)
  );
}

function hasClassMethod(program: AstNode, method: string): boolean {
  return someNode(
    program,
    (node) =>
      (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') &&
      readIdentifier(asNode(node.key)) === method,
  );
}

function hasOwnerCallable(program: AstNode, method: string): boolean {
  return (
    hasClassMethod(program, method) ||
    someNode(
      program,
      (node) =>
        (node.type === 'FunctionDeclaration' && readIdentifier(asNode(node.id)) === method) ||
        (node.type === 'ImportSpecifier' &&
          (readIdentifier(asNode(node.local)) === method ||
            readIdentifier(asNode(node.imported)) === method)),
    )
  );
}

function someNode(value: unknown, predicate: (node: AstNode) => boolean): boolean {
  return findAstNode(value, predicate) !== undefined;
}

function readCallName(node: AstNode | undefined): string {
  return readIdentifier(node) || readMemberName(node);
}

function readMemberName(node: AstNode | undefined): string {
  return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
    ? readIdentifier(asNode(node.property))
    : '';
}

function readMemberPath(node: AstNode | undefined): string {
  if (!node) return '';
  if (node.type === 'Identifier') return readIdentifier(node);
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return '';
  const object = readMemberPath(asNode(node.object));
  const property = readIdentifier(asNode(node.property));
  return object && property ? `${object}.${property}` : '';
}

function readIdentifier(node: AstNode | undefined): string {
  return node && typeof node.name === 'string' ? node.name : '';
}

function readString(node: AstNode | undefined): string {
  return node && typeof node.value === 'string' ? node.value : '';
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AstNode)
    : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}
