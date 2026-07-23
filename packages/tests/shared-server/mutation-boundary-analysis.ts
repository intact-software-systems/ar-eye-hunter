import { parse } from '@babel/parser';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
  return mutationBoundaryFiles().map((filePath) => {
    const analysis = analyzeTypeScript(readFileSync(filePath, 'utf8'), filePath);
    return {
      filePath,
      directMutatorCalls: analysis.memberCallNames.filter((name) =>
        FORBIDDEN_DIRECT_MUTATORS.has(name) && !ALLOWED_DIRECT_BOUNDARY_CALLS.has(name)
      ),
      mutatingImports: analysis.valueImportNames.filter((name) =>
        FORBIDDEN_MUTATING_IMPORTS.has(name)
      ),
    };
  }).filter((violation) =>
    violation.directMutatorCalls.length > 0 || violation.mutatingImports.length > 0
  );
}

interface SourceBoundaryAnalysis {
  readonly memberCallNames: readonly string[];
  readonly valueImportNames: readonly string[];
}

function mutationBoundaryFiles(): readonly string[] {
  const routeFiles = readdirSync('apps/api-v1/src/routes')
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join('apps/api-v1/src/routes', name));
  return [
    ...routeFiles,
    'packages/shared-server/crdt/RallarCrdtServer.ts',
    'packages/shared-server/rallar-system/ws-system-topics.ts',
    'packages/shared-server/rallar-system/services/ws-lifecycle-service.ts',
  ];
}

function analyzeTypeScript(source: string, filePath: string): SourceBoundaryAnalysis {
  const program = parse(source, {
    sourceType: 'module',
    sourceFilename: filePath,
    createImportExpressions: true,
    plugins: ['typescript', 'importAttributes'],
  }).program;
  const memberCallNames: string[] = [];
  const valueImportNames: string[] = [];

  walk(program, (node) => {
    if (node.type === 'ImportDeclaration') {
      if (node.importKind === 'type') return;
      for (const specifier of node.specifiers ?? []) {
        if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
          valueImportNames.push(readNodeName(specifier.imported));
        }
      }
      return;
    }
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    const callee = node.callee;
    if (callee?.type !== 'MemberExpression' && callee?.type !== 'OptionalMemberExpression') return;
    if (!isAppInboxReceiver(callee.object)) memberCallNames.push(readNodeName(callee.property));
  });

  return { memberCallNames, valueImportNames };
}

type AstNode = { readonly type: string; readonly [key: string]: unknown };

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
  if (!value || typeof value !== 'object') return '';
  const node = value as { name?: unknown; value?: unknown };
  return typeof node.name === 'string'
    ? node.name
    : typeof node.value === 'string'
    ? node.value
    : '';
}

function isAppInboxReceiver(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const node = value as AstNode;
  if (node.type === 'Identifier') return /App.*Inbox/u.test(readNodeName(node));
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    const callee = node.callee;
    return !!callee && typeof callee === 'object' &&
      /App.*Inbox/u.test(readNodeName((callee as AstNode).property));
  }
  return false;
}
