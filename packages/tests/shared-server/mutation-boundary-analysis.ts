import { parse } from '@babel/parser';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { findCapabilityMutationCalls } from './mutation-boundary-capabilities.ts';
import { findMutationBoundaryViolationsFromRootFiles } from './mutation-boundary-traversal.ts';

const FORBIDDEN_DIRECT_MUTATORS = new Set([
  'registerAuthUser',
  'putSession',
  'deleteSession',
  'putWebSocketTicket',
  'consumeWebSocketTicket',
  'putAgentSessionTicket',
  'consumeAgentSessionTicket',
  'upsertPrincipal',
  'upsertInstance',
  'connectSession',
  'heartbeatSession',
  'disconnectSession',
  'createGroup',
  'updateGroup',
  'joinGroup',
  'putConfig',
  'deleteConfig',
  'putOverride',
  'deleteOverride',
  'reconfigureGroupTopology',
  'removeGroupTopology',
  'writeTopologyMutation',
  'writeRttMutation',
  'writeRtcRttMutation',
  'writeSnapshot',
  'updateDocumentLifecycle',
  'append',
]);

const FORBIDDEN_MUTATING_IMPORTS = new Set([
  'GroupTopologyManagementService',
  'GroupTopologyConfigRepository',
  'GroupStateRepository',
  'RtcRttRepository',
  'RtcTopologySnapshotRepository',
]);

const FORBIDDEN_IMPORT_STEMS = [
  'GroupTopologyManagementService',
  'GroupTopologyConfigRepository',
  'GroupStateRepository',
  'RtcRttRepository',
  'RtcTopologySnapshotRepository',
] as const;

const APP_INBOX_RECEIVER_FACTORIES = new Set(['readAppAuthInbox']);
const EXACT_APP_INBOX_RECEIVERS = new Set(['appAuthInbox']);

export const ALLOWED_DIRECT_BOUNDARY_CALLS = new Set([
  'exportBackupBundle',
  'exportDebugBundle',
  'findSnapshot',
  'listAfter',
  'listDocuments',
  'readConfig',
  'readOverride',
  'readSnapshot',
  'readTopologyView',
  'requireApiAdminSession',
  'requireApiAuthSession',
  'requireSharedWsAuthSession',
  'requireWsAuthSession',
  'resetMetrics',
  'verifyIntegrity',
]);

export interface MutationBoundaryViolation {
  readonly filePath: string;
  readonly directMutatorCalls: readonly string[];
  readonly mutatingImports: readonly string[];
}

export function findMutationBoundaryViolations(): readonly MutationBoundaryViolation[] {
  return findMutationBoundaryViolationsFromRoots(mutationBoundaryFiles());
}

export function findMutationBoundaryViolationsFromRoots(
  roots: readonly string[],
): readonly MutationBoundaryViolation[] {
  return findMutationBoundaryViolationsFromRootFiles({
    roots,
    analyze: analyzeMutationBoundarySource,
  });
}

export function analyzeMutationBoundarySource(
  source: string,
  filePath: string,
): MutationBoundaryViolation {
  const program = parse(source, {
    sourceType: 'module',
    sourceFilename: filePath,
    createImportExpressions: true,
    plugins: ['typescript', 'importAttributes'],
  }).program;
  const directMutatorCalls = new Set<string>();
  const mutatingImports = new Set<string>();
  const directAliases = new Map<string, string>();
  for (const call of findCapabilityMutationCalls(source, filePath)) {
    directMutatorCalls.add(call);
  }

  walk(program, (node) => {
    if (node.type === 'ImportDeclaration') {
      readImportDeclaration(node, mutatingImports, directAliases);
      return;
    }
    if (node.type === 'ImportExpression') {
      const sourceValue = readStringLiteral(node.source);
      if (sourceValue && isForbiddenImportSource(sourceValue)) {
        mutatingImports.add(sourceValue);
      }
      return;
    }
    if (node.type === 'VariableDeclarator') {
      readDirectAliases(node, directAliases);
      return;
    }
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    const callName = readCallName(node.callee, directAliases);
    if (
      callName &&
      FORBIDDEN_DIRECT_MUTATORS.has(callName) &&
      !isKnownAppInboxCall(node.callee)
    ) {
      directMutatorCalls.add(callName);
    }
  });

  return {
    filePath,
    directMutatorCalls: [...directMutatorCalls].toSorted(),
    mutatingImports: [...mutatingImports].toSorted(),
  };
}

function mutationBoundaryFiles(): readonly string[] {
  const routeFiles = readdirSync('apps/api-v1/src/routes')
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join('apps/api-v1/src/routes', name));
  return [
    ...routeFiles,
    'apps/api-v1/src/services/create-api-admin-mutation-gateway.ts',
    'apps/api-v1/src/services/create-crdt-ws-mutation-ingress.ts',
    'apps/api-v1/src/services/request-auth-service.ts',
    'packages/shared-server/crdt/RallarCrdtServer.ts',
    'packages/shared-server/rallar-system/ws-system-topics.ts',
    'packages/shared-server/rallar-system/rtc-topology/topic/init-rtc-rtt-topic.ts',
    'packages/shared-server/rallar-system/ws-rtc-topology-runtime.ts',
    'packages/shared-server/rallar-system/services/authorised-ws-client-app-inbox.ts',
    'packages/shared-server/rallar-system/group-state/presence/reconcile-expired-group-presence.ts',
    'packages/shared-server/rallar-system/services/ws-lifecycle-service.ts',
  ];
}

type AstNode = { readonly type: string; readonly [key: string]: unknown };

function readImportDeclaration(
  node: AstNode,
  mutatingImports: Set<string>,
  directAliases: Map<string, string>,
): void {
  if (node.importKind === 'type') return;
  const source = readStringLiteral(node.source) ?? '';
  const forbiddenSource = isForbiddenImportSource(source);
  for (const rawSpecifier of asNodeArray(node.specifiers)) {
    if (rawSpecifier.importKind === 'type') continue;
    const imported = readNodeName(rawSpecifier.imported);
    const local = readNodeName(rawSpecifier.local);
    if (FORBIDDEN_MUTATING_IMPORTS.has(imported)) mutatingImports.add(imported);
    if (
      forbiddenSource &&
      (rawSpecifier.type === 'ImportDefaultSpecifier' ||
        rawSpecifier.type === 'ImportNamespaceSpecifier')
    ) {
      mutatingImports.add(local || source);
    }
    if (FORBIDDEN_DIRECT_MUTATORS.has(imported) && local) {
      directAliases.set(local, imported);
    }
  }
}

function readDirectAliases(node: AstNode, aliases: Map<string, string>): void {
  const id = asNode(node.id);
  const init = asNode(node.init);
  if (!id || !init) return;
  if (id.type === 'Identifier') {
    const memberName = readMemberName(init);
    if (memberName && FORBIDDEN_DIRECT_MUTATORS.has(memberName)) {
      aliases.set(readNodeName(id), memberName);
    }
    return;
  }
  if (id.type !== 'ObjectPattern') return;
  for (const property of asNodeArray(id.properties)) {
    const importedName = readNodeName(property.key);
    if (!FORBIDDEN_DIRECT_MUTATORS.has(importedName)) continue;
    const local = asNode(property.value);
    const localName = local?.type === 'AssignmentPattern'
      ? readNodeName(asNode(local.left))
      : readNodeName(local);
    if (localName) aliases.set(localName, importedName);
  }
}

function readCallName(value: unknown, aliases: Map<string, string>): string {
  const node = asNode(value);
  if (!node) return '';
  if (node.type === 'Identifier') {
    const name = readNodeName(node);
    return aliases.get(name) ?? name;
  }
  return readMemberName(node);
}

function readMemberName(node: AstNode): string {
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return '';
  return readNodeName(node.property);
}

function isKnownAppInboxCall(value: unknown): boolean {
  const callee = asNode(value);
  if (
    !callee ||
    (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression')
  ) return false;
  const receiver = asNode(callee.object);
  if (receiver?.type === 'Identifier') {
    return EXACT_APP_INBOX_RECEIVERS.has(readNodeName(receiver));
  }
  if (
    !receiver || (receiver.type !== 'CallExpression' && receiver.type !== 'OptionalCallExpression')
  ) {
    return false;
  }
  const factory = asNode(receiver.callee);
  return factory !== undefined && APP_INBOX_RECEIVER_FACTORIES.has(readMemberName(factory));
}

function isForbiddenImportSource(source: string): boolean {
  const fileName = source.split('/').at(-1) ?? source;
  return FORBIDDEN_IMPORT_STEMS.some((stem) => fileName.includes(stem));
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

function readNodeName(value: unknown): string {
  const node = asNode(value);
  if (!node) return '';
  return typeof node.name === 'string'
    ? node.name
    : typeof node.value === 'string'
    ? node.value
    : '';
}

function readStringLiteral(value: unknown): string | undefined {
  const node = asNode(value);
  return node && typeof node.value === 'string' ? node.value : undefined;
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodeArray(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}
