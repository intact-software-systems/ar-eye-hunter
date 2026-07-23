import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';

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
}

const CLIENT_ROUTE = '/api/state/apps/:applicationId/workspaces/:workspaceId/clients';
const GROUP_ROUTE = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups';
const GROUP_ITEM_ROUTE = `${GROUP_ROUTE}/:groupId`;
const TOPOLOGY_ROUTE = `${GROUP_ITEM_ROUTE}/topology`;

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
  e: 'packages/shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts',
  s: 'packages/shared-server/rallar-system/ws-system-topics.ts',
  d: 'packages/shared-server/crdt/RallarCrdtServer.ts',
} as const;

const OWNERS = {
  C: 'packages/shared-server/rallar-system/services/AppClientInboxService.ts',
  G: 'packages/shared-server/rallar-system/services/AppGroupInboxService.ts',
  A: 'packages/shared-server/rallar-system/services/AppAuthInboxService.ts',
  D: 'packages/shared-server/rallar-system/services/AppCrdtInboxService.ts',
  N: 'packages/shared-server/rallar-system/services/AppAdminInboxService.ts',
} as const;

const INVENTORY_ROWS = `
HTTP\tPUT ${CLIENT_ROUTE}/:principalId/principal\tCLIENT_PRINCIPAL_UPSERT\tc\t/clients/:principalId/principal\tc\tprocessClientAppInbox\tC\tAppClientInboxService.processCommand
HTTP\tPUT ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId\tCLIENT_INSTANCE_UPSERT\tc\t/instances/:clientInstanceId\tc\tprocessClientAppInbox\tC\tAppClientInboxService.processCommand
HTTP\tPUT ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId/sessions/:sessionId\tCLIENT_SESSION_CONNECT\tc\t/sessions/:sessionId\tc\tprocessClientAppInbox\tC\tAppClientInboxService.processCommand
HTTP\tPOST ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId/sessions/:sessionId/heartbeat\tCLIENT_SESSION_HEARTBEAT\tc\t/sessions/:sessionId/heartbeat\tc\tprocessClientAppInbox\tC\tAppClientInboxService.processCommand
HTTP\tPOST ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId/sessions/:sessionId/disconnect\tCLIENT_SESSION_DISCONNECT\tc\t/sessions/:sessionId/disconnect\tc\tprocessClientAppInbox\tC\tAppClientInboxService.processCommand
HTTP\tGET /api/ws/:sessionId upgrade\tAUTH_WS_TICKET_CONSUME\tw\t'/api/ws/:sessionId'\trq\trequireSharedWsAuthSession\tA\tAppAuthInboxService.processCommand
HTTP\tGET /api/ws/:sessionId upgrade\tCLIENT_AUTHORISED_WS_CONNECT\tw\t'/api/ws/:sessionId'\tw\tenqueueAuthorisedWsClientConnect\tC\tAppClientInboxService.processAuthorisedWsConnect
WS_LIFECYCLE\twebsocket onClose\tCLIENT_AUTHORISED_WS_DISCONNECT\tl\tonClose:\tl\tenqueueClientSessionDisconnect\tC\tAppClientInboxService.processAuthorisedWsDisconnect
MAINTENANCE\tclient session expiry reconciliation\tCLIENT_EXPIRED_SESSIONS\te\tenqueuePresenceExpiryReconciliation\te\tenqueueExpiredSessions\tC\tAppClientInboxService.processExpiredSessionCommands
HTTP\tPOST /api/auth/register\tAUTH_USER_REGISTER\ta\t'/api/auth/register'\ta\tregisterUser\tA\tAppAuthInboxService.processCommand
HTTP\tPOST /api/auth/login\tAUTH_SESSION_ISSUE\ta\t'/api/auth/login'\ta\tissueSession\tA\tAppAuthInboxService.processCommand
HTTP\tPOST /api/auth/logout\tAUTH_SESSION_LOGOUT\ta\t'/api/auth/logout'\ta\tlogoutSession\tA\tAppAuthInboxService.processCommand
HTTP\tPOST /api/auth/ws-ticket\tAUTH_WS_TICKET_ISSUE\ta\t'/api/auth/ws-ticket'\ta\tissueWebSocketTicket\tA\tAppAuthInboxService.processCommand
HTTP\tPOST /api/auth/agent-session-tickets\tAUTH_AGENT_SESSION_TICKETS_ISSUE\ta\t'/api/auth/agent-session-tickets'\ta\tissueAgentSessionTickets\tA\tAppAuthInboxService.processCommand
HTTP\tPOST /api/auth/agent-session-tickets/consume\tAUTH_AGENT_SESSION_TICKET_CONSUME\ta\t'/api/auth/agent-session-tickets/consume'\ta\tconsumeAgentSessionTicket\tA\tAppAuthInboxService.processCommand
HTTP\tPOST ${GROUP_ROUTE}\tGROUP_CREATE\tg\t'/api/state/apps/:applicationId/workspaces/:workspaceId/groups'\tg\tAppInboxType.GROUP_CREATE\tG\tAppGroupInboxService.processMutation
HTTP\tPUT ${GROUP_ITEM_ROUTE}\tGROUP_UPDATE\tg\t'/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId'\tg\tAppInboxType.GROUP_UPDATE\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/director/appoint\tGROUP_DIRECTOR_APPOINT\tg\t/director/appoint\tg\tAppInboxType.GROUP_DIRECTOR_APPOINT\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/join\tGROUP_JOIN\tg\t/groups/:groupId/join\tg\tAppInboxType.GROUP_JOIN\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/invites/:principalId\tGROUP_INVITE_CREATE\tg\t/invites/:principalId\tg\tAppInboxType.GROUP_INVITE_CREATE\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/invites/:principalId/revoke\tGROUP_INVITE_REVOKE\tg\t/invites/:principalId/revoke\tg\tAppInboxType.GROUP_INVITE_REVOKE\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/invites/accept\tGROUP_INVITE_ACCEPT\tg\t/invites/accept\tg\tAppInboxType.GROUP_INVITE_ACCEPT\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/join-code/rotate\tGROUP_JOIN_CODE_ROTATE\tg\t/join-code/rotate\tg\tAppInboxType.GROUP_JOIN_CODE_ROTATE\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/members/:principalId/remove\tGROUP_MEMBER_REMOVE\tg\t/members/:principalId/remove\tg\tAppInboxType.GROUP_MEMBER_REMOVE\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/members/:principalId/ban\tGROUP_MEMBER_BAN\tg\t/members/:principalId/ban\tg\tAppInboxType.GROUP_MEMBER_BAN\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/members/:principalId/unban\tGROUP_MEMBER_UNBAN\tg\t/members/:principalId/unban\tg\tAppInboxType.GROUP_MEMBER_UNBAN\tG\tAppGroupInboxService.processMutation
HTTP\tPUT ${GROUP_ITEM_ROUTE}/members/:principalId/role\tGROUP_MEMBER_ROLE_SET\tg\t/members/:principalId/role\tg\tAppInboxType.GROUP_MEMBER_ROLE_SET\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/owner/transfer\tGROUP_OWNERSHIP_TRANSFER\tg\t/owner/transfer\tg\tAppInboxType.GROUP_OWNERSHIP_TRANSFER\tG\tAppGroupInboxService.processMutation
HTTP\tPUT ${GROUP_ITEM_ROUTE}/members/:principalId\tGROUP_MEMBER_UPSERT\tg\t/members/:principalId\tg\tAppInboxType.GROUP_MEMBER_UPSERT\tG\tAppGroupInboxService.processMutation
HTTP\tPUT ${GROUP_ITEM_ROUTE}/sessions/:sessionId\tGROUP_PRESENCE_CONNECT\tg\t/sessions/:sessionId\tg\tAppInboxType.GROUP_PRESENCE_CONNECT\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/sessions/:sessionId/heartbeat\tGROUP_PRESENCE_HEARTBEAT\tg\t/sessions/:sessionId/heartbeat\tg\tAppInboxType.GROUP_PRESENCE_HEARTBEAT\tG\tAppGroupInboxService.processMutation
HTTP\tPOST ${GROUP_ITEM_ROUTE}/sessions/:sessionId/disconnect\tGROUP_PRESENCE_DISCONNECT\tg\t/sessions/:sessionId/disconnect\tg\tAppInboxType.GROUP_PRESENCE_DISCONNECT\tG\tAppGroupInboxService.processMutation
MAINTENANCE\tgroup presence expiry reconciliation\tGROUP_PRESENCE_EXPIRE\te\tenqueuePresenceExpiryReconciliation\te\tenqueueExpiredPresenceSessions\tG\tAppGroupInboxService.processMutation
WS_LIFECYCLE\twebsocket onClose group cleanup\tGROUP_PRESENCE_SESSION_CLEANUP\tl\tonClose:\tl\tenqueueGroupSessionCleanup\tG\tAppGroupInboxService.processMutation
HTTP\tPUT ${TOPOLOGY_ROUTE}/config\tTOPOLOGY_CONFIG_PUT\tt\t/topology/config\tt\tAppInboxType.TOPOLOGY_CONFIG_PUT\tG\tAppGroupInboxService.processTopologyConfigMutation
HTTP\tDELETE ${TOPOLOGY_ROUTE}/config\tTOPOLOGY_CONFIG_DELETE\tt\t/topology/config\tt\tAppInboxType.TOPOLOGY_CONFIG_DELETE\tG\tAppGroupInboxService.processTopologyConfigMutation
HTTP\tPUT ${TOPOLOGY_ROUTE}/override\tTOPOLOGY_OVERRIDE_PUT\tt\t/topology/override\tt\tAppInboxType.TOPOLOGY_OVERRIDE_PUT\tG\tAppGroupInboxService.processTopologyConfigMutation
HTTP\tDELETE ${TOPOLOGY_ROUTE}/override\tTOPOLOGY_OVERRIDE_DELETE\tt\t/topology/override\tt\tAppInboxType.TOPOLOGY_OVERRIDE_DELETE\tG\tAppGroupInboxService.processTopologyConfigMutation
HTTP\tPOST ${TOPOLOGY_ROUTE}/reconfigure\tTOPOLOGY_RECONFIGURE\tt\t/topology/reconfigure\tt\tAppInboxType.TOPOLOGY_RECONFIGURE\tG\tAppGroupInboxService.processTopologyReconfigureMutation
HTTP\tPOST /api/admin/operations/topology/recompute\tTOPOLOGY_RECONFIGURE\tad\t'/api/admin/operations/topology/recompute'\tag\tprocessAuthenticatedEntryUntilCompletionResult\tG\tAppGroupInboxService.processTopologyReconfigureMutation
WS_INBOX\ttopic rallar/rtt\tRTC_RTT_SUBMIT\ts\tAppTopics.rtt\ts\tenqueueRtcRttMutation\tG\tAppGroupInboxService.processRtcRttMutation
WS_INBOX\ttopic rallar/crdt/update\tCRDT_UPDATE_APPEND\td\tkind === 'update'\td\tmutationIngress.enqueueUpdate\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/crdt/admin/documents/rebuild-projection\tCRDT_PROJECTION_REBUILD\tcr\t'/api/crdt/admin/documents/rebuild-projection'\tcr\tmutate(c, options, 'rebuild-projection'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/crdt/admin/documents/compact\tCRDT_SNAPSHOT_COMPACT\tcr\t'/api/crdt/admin/documents/compact'\tcr\tmutate(c, options, 'compact'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/admin/operations/crdt/compact\tCRDT_SNAPSHOT_COMPACT\tad\t'/api/admin/operations/crdt/compact'\tag\tprocessAdminMutationUntilCompletion('compact'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/crdt/admin/documents/lifecycle\tCRDT_LIFECYCLE_UPDATE\tcr\t'/api/crdt/admin/documents/lifecycle'\tcr\tmutate(c, options, 'lifecycle'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/admin/operations/crdt/lifecycle\tCRDT_LIFECYCLE_UPDATE\tad\t'/api/admin/operations/crdt/lifecycle'\tag\tprocessAdminMutationUntilCompletion('lifecycle'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/crdt/admin/documents/erase\tCRDT_ERASE\tcr\t'/api/crdt/admin/documents/erase'\tcr\tmutate(c, options, 'erase'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/admin/operations/crdt/erase\tCRDT_ERASE\tad\t'/api/admin/operations/crdt/erase'\tag\tprocessAdminMutationUntilCompletion('erase'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/admin/operations/maintenance/prune-expired\tADMIN_PRUNE_EXPIRED\tad\t'/api/admin/operations/maintenance/prune-expired'\tag\tappAdmin.pruneExpired\tN\tAppAdminInboxService.processCommand
`;

export const MUTATION_ROUTE_INVENTORY: readonly MutationRouteInventoryEntry[] = decodeInventory(
  INVENTORY_ROWS,
);

export function validateMutationRouteInventory(
  inventory: readonly MutationRouteInventoryEntry[],
): readonly string[] {
  const issues: string[] = [];
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
    for (
      const field of [
        'owner',
        'sourcePath',
        'registrationMarker',
        'enqueueSourcePath',
        'enqueueMarker',
        'ownerSourcePath',
      ] as const
    ) {
      if (item[field] !== canonical[field]) issues.push(`${key(item)} has incorrect ${field}`);
    }
    checkRegistration(issues, item);
    checkAstMarker(issues, item.enqueueSourcePath, item.enqueueMarker, 'enqueue', item);
    checkAstMarker(
      issues,
      item.ownerSourcePath,
      `AppInboxType.${item.type}`,
      'type ownership',
      item,
    );
    checkOwnerMethod(issues, item);
  }
  return issues;
}

function decodeInventory(rows: string): readonly MutationRouteInventoryEntry[] {
  return rows.trim().split('\n').map((row) => {
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
    ] = row.split('\t');
    const sourcePath = PATHS[source as keyof typeof PATHS];
    const enqueueSourcePath = PATHS[enqueueSource as keyof typeof PATHS];
    const ownerSourcePath = OWNERS[ownerSource as keyof typeof OWNERS];
    const appInboxType = AppInboxType[type as keyof typeof AppInboxType];
    if (!sourcePath || !enqueueSourcePath || !ownerSourcePath || !appInboxType) {
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
    };
  });
}

function key(item: MutationRouteInventoryEntry): string {
  return `${item.transport}:${item.entrypoint}:${item.type}`;
}

function checkRegistration(
  issues: string[],
  item: MutationRouteInventoryEntry,
): void {
  if (item.transport !== 'HTTP') {
    checkAstMarker(issues, item.sourcePath, item.registrationMarker, 'registration', item);
    return;
  }
  const [method, rawPath] = item.entrypoint.split(' ');
  const routePath = rawPath;
  const program = readProgram(issues, item.sourcePath, 'registration', item);
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
): void {
  const program = readProgram(issues, filePath, label, item);
  if (program && !hasExactMarker(program, marker)) {
    issues.push(`${key(item)} ${label} marker is absent from ${filePath}`);
  }
}

function checkOwnerMethod(issues: string[], item: MutationRouteInventoryEntry): void {
  const method = item.owner.split('.').at(-1) ?? '';
  const program = readProgram(issues, item.ownerSourcePath, 'owner', item);
  if (program && !hasClassMethod(program, method)) {
    issues.push(`${key(item)} owner method is absent from ${item.ownerSourcePath}`);
  }
}

type AstNode = { readonly type: string; readonly [key: string]: unknown };

const programCache = new Map<string, AstNode>();

function readProgram(
  issues: string[],
  filePath: string,
  label: string,
  item: MutationRouteInventoryEntry,
): AstNode | undefined {
  const cached = programCache.get(filePath);
  if (cached) return cached;
  try {
    const program = parse(readFileSync(filePath, 'utf8'), {
      sourceType: 'module',
      sourceFilename: filePath,
      plugins: ['typescript', 'importAttributes'],
    }).program as AstNode;
    programCache.set(filePath, program);
    return program;
  } catch {
    issues.push(`${key(item)} ${label} source cannot be parsed: ${filePath}`);
    return undefined;
  }
}

function hasRouteRegistration(program: AstNode, method: string, routePath: string): boolean {
  return someNode(program, (node) => {
    if (node.type !== 'CallExpression') return false;
    const callee = asNode(node.callee);
    const arguments_ = asNodes(node.arguments);
    return readMemberName(callee) === method && readString(arguments_[0]) === routePath;
  });
}

function hasExactMarker(program: AstNode, marker: string): boolean {
  const member = marker.match(/^(\w+)\.(\w+)$/);
  if (member) {
    return someNode(program, (node) => {
      const memberPath = readMemberPath(node);
      return memberPath === marker || memberPath.endsWith(`.${marker}`);
    });
  }
  const quoted = marker.match(/^'([^']+)'$/);
  if (quoted) return someNode(program, (node) => readString(node) === quoted[1]);
  const comparison = marker.match(/^(\w+) === '([^']+)'$/);
  if (comparison) {
    return someNode(
      program,
      (node) =>
        node.type === 'BinaryExpression' && node.operator === '===' &&
        readIdentifier(asNode(node.left)) === comparison[1] &&
        readString(asNode(node.right)) === comparison[2],
    );
  }
  const call = marker.match(/^(?:(\w+)\.)?(\w+)\((?:[^']*'([^']+)')?/);
  if (call) {
    return someNode(program, (node) => {
      if (node.type !== 'CallExpression') return false;
      const callee = asNode(node.callee);
      if (readCallName(callee) !== call[2]) return false;
      if (call[1] && readIdentifier(asNode(callee?.object)) !== call[1]) return false;
      return !call[3] ||
        asNodes(node.arguments).some((argument) => readString(argument) === call[3]);
    });
  }
  const property = marker.replace(/:$/, '');
  return someNode(
    program,
    (node) =>
      readIdentifier(node) === property || readMemberName(node) === property ||
      ((node.type === 'ObjectProperty' || node.type === 'ObjectMethod') &&
        readIdentifier(asNode(node.key)) === property),
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

function someNode(value: unknown, predicate: (node: AstNode) => boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => someNode(item, predicate));
  const node = value as AstNode;
  if (typeof node.type === 'string' && predicate(node)) return true;
  return Object.entries(node).some(([name, child]) =>
    !['loc', 'start', 'end', 'comments', 'tokens'].includes(name) && someNode(child, predicate)
  );
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
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}
