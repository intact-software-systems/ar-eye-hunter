import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import {
  ALLOWED_DIRECT_BOUNDARY_CALLS,
  findMutationBoundaryViolations,
} from './mutation-boundary-analysis.ts';
import { ROUTING_SOURCE_MARKERS } from './mutation-routing-markers.ts';

interface MutationRouteInventoryEntry {
  readonly transport: 'HTTP' | 'WS_INBOX' | 'WS_LIFECYCLE' | 'MAINTENANCE';
  readonly entrypoint: string;
  readonly type: AppInboxType;
  readonly owner: string;
}

const CLIENT_ROUTE = '/api/state/apps/:applicationId/workspaces/:workspaceId/clients';
const GROUP_ROUTE = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups';
const GROUP_ITEM_ROUTE = `${GROUP_ROUTE}/:groupId`;
const TOPOLOGY_ROUTE = `${GROUP_ITEM_ROUTE}/topology`;

const MUTATION_ROUTE_INVENTORY: readonly MutationRouteInventoryEntry[] = [
  route(
    'HTTP',
    `PUT ${CLIENT_ROUTE}/:principalId/principal`,
    AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    'AppClientInboxService.processCommand',
  ),
  route(
    'HTTP',
    `PUT ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId`,
    AppInboxType.CLIENT_INSTANCE_UPSERT,
    'AppClientInboxService.processCommand',
  ),
  route(
    'HTTP',
    `PUT ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId/sessions/:sessionId`,
    AppInboxType.CLIENT_SESSION_CONNECT,
    'AppClientInboxService.processCommand',
  ),
  route(
    'HTTP',
    `POST ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId/sessions/:sessionId/heartbeat`,
    AppInboxType.CLIENT_SESSION_HEARTBEAT,
    'AppClientInboxService.processCommand',
  ),
  route(
    'HTTP',
    `POST ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId/sessions/:sessionId/disconnect`,
    AppInboxType.CLIENT_SESSION_DISCONNECT,
    'AppClientInboxService.processCommand',
  ),
  route(
    'HTTP',
    'GET /api/ws/:sessionId upgrade',
    AppInboxType.AUTH_WS_TICKET_CONSUME,
    'AppAuthInboxService.processCommand',
  ),
  route(
    'HTTP',
    'GET /api/ws/:sessionId upgrade',
    AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
    'AppClientInboxService.processCommand',
  ),
  route(
    'WS_LIFECYCLE',
    'websocket onClose',
    AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
    'AppClientInboxService.processCommand',
  ),
  route(
    'MAINTENANCE',
    'client session expiry reconciliation',
    AppInboxType.CLIENT_EXPIRED_SESSIONS,
    'AppClientInboxService.processExpiredSessionCommands',
  ),
  route(
    'HTTP',
    'POST /api/auth/register',
    AppInboxType.AUTH_USER_REGISTER,
    'AppAuthInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/auth/login',
    AppInboxType.AUTH_SESSION_ISSUE,
    'AppAuthInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/auth/logout',
    AppInboxType.AUTH_SESSION_LOGOUT,
    'AppAuthInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/auth/ws-ticket',
    AppInboxType.AUTH_WS_TICKET_ISSUE,
    'AppAuthInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/auth/agent-session-tickets',
    AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE,
    'AppAuthInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/auth/agent-session-tickets/consume',
    AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
    'AppAuthInboxService.processCommand',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ROUTE}`,
    AppInboxType.GROUP_CREATE,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `PUT ${GROUP_ITEM_ROUTE}`,
    AppInboxType.GROUP_UPDATE,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/director/appoint`,
    AppInboxType.GROUP_DIRECTOR_APPOINT,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/join`,
    AppInboxType.GROUP_JOIN,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/invites/:principalId`,
    AppInboxType.GROUP_INVITE_CREATE,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/invites/:principalId/revoke`,
    AppInboxType.GROUP_INVITE_REVOKE,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/invites/accept`,
    AppInboxType.GROUP_INVITE_ACCEPT,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/join-code/rotate`,
    AppInboxType.GROUP_JOIN_CODE_ROTATE,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/members/:principalId/remove`,
    AppInboxType.GROUP_MEMBER_REMOVE,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/members/:principalId/ban`,
    AppInboxType.GROUP_MEMBER_BAN,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/members/:principalId/unban`,
    AppInboxType.GROUP_MEMBER_UNBAN,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `PUT ${GROUP_ITEM_ROUTE}/members/:principalId/role`,
    AppInboxType.GROUP_MEMBER_ROLE_SET,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/owner/transfer`,
    AppInboxType.GROUP_OWNERSHIP_TRANSFER,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `PUT ${GROUP_ITEM_ROUTE}/members/:principalId`,
    AppInboxType.GROUP_MEMBER_UPSERT,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `PUT ${GROUP_ITEM_ROUTE}/sessions/:sessionId`,
    AppInboxType.GROUP_PRESENCE_CONNECT,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/sessions/:sessionId/heartbeat`,
    AppInboxType.GROUP_PRESENCE_HEARTBEAT,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `POST ${GROUP_ITEM_ROUTE}/sessions/:sessionId/disconnect`,
    AppInboxType.GROUP_PRESENCE_DISCONNECT,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'MAINTENANCE',
    'group presence expiry reconciliation',
    AppInboxType.GROUP_PRESENCE_EXPIRE,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'WS_LIFECYCLE',
    'websocket onClose group cleanup',
    AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
    'AppGroupInboxService.processMutation',
  ),
  route(
    'HTTP',
    `PUT ${TOPOLOGY_ROUTE}/config`,
    AppInboxType.TOPOLOGY_CONFIG_PUT,
    'AppGroupInboxService.processTopologyConfigMutation',
  ),
  route(
    'HTTP',
    `DELETE ${TOPOLOGY_ROUTE}/config`,
    AppInboxType.TOPOLOGY_CONFIG_DELETE,
    'AppGroupInboxService.processTopologyConfigMutation',
  ),
  route(
    'HTTP',
    `PUT ${TOPOLOGY_ROUTE}/override`,
    AppInboxType.TOPOLOGY_OVERRIDE_PUT,
    'AppGroupInboxService.processTopologyConfigMutation',
  ),
  route(
    'HTTP',
    `DELETE ${TOPOLOGY_ROUTE}/override`,
    AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
    'AppGroupInboxService.processTopologyConfigMutation',
  ),
  route(
    'HTTP',
    `POST ${TOPOLOGY_ROUTE}/reconfigure`,
    AppInboxType.TOPOLOGY_RECONFIGURE,
    'AppGroupInboxService.processTopologyReconfigureMutation',
  ),
  route(
    'HTTP',
    'POST /api/admin/operations/topology/recompute',
    AppInboxType.TOPOLOGY_RECONFIGURE,
    'AppGroupInboxService.processTopologyReconfigureMutation',
  ),
  route(
    'WS_INBOX',
    'topic rallar/rtt',
    AppInboxType.RTC_RTT_SUBMIT,
    'AppGroupInboxService.processRtcRttMutation',
  ),
  route(
    'WS_INBOX',
    'topic rallar/crdt/update',
    AppInboxType.CRDT_UPDATE_APPEND,
    'AppCrdtInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/crdt/admin/documents/rebuild-projection',
    AppInboxType.CRDT_PROJECTION_REBUILD,
    'AppCrdtInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/crdt/admin/documents/compact',
    AppInboxType.CRDT_SNAPSHOT_COMPACT,
    'AppCrdtInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/admin/operations/crdt/compact',
    AppInboxType.CRDT_SNAPSHOT_COMPACT,
    'AppCrdtInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/crdt/admin/documents/lifecycle',
    AppInboxType.CRDT_LIFECYCLE_UPDATE,
    'AppCrdtInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/admin/operations/crdt/lifecycle',
    AppInboxType.CRDT_LIFECYCLE_UPDATE,
    'AppCrdtInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/crdt/admin/documents/erase',
    AppInboxType.CRDT_ERASE,
    'AppCrdtInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/admin/operations/crdt/erase',
    AppInboxType.CRDT_ERASE,
    'AppCrdtInboxService.processCommand',
  ),
  route(
    'HTTP',
    'POST /api/admin/operations/maintenance/prune-expired',
    AppInboxType.ADMIN_PRUNE_EXPIRED,
    'AppAdminInboxService.processCommand',
  ),
] as const;

describe('AppInbox mutation routing contract', () => {
  it('inventories every command type with an explicit transport, entrypoint, and owner', () => {
    expect(new Set(MUTATION_ROUTE_INVENTORY.map((entry) => entry.type)))
      .toEqual(new Set(Object.values(AppInboxType)));
    expect(new Set(MUTATION_ROUTE_INVENTORY.map(toInventoryKey)).size)
      .toBe(MUTATION_ROUTE_INVENTORY.length);
    expect(MUTATION_ROUTE_INVENTORY.every((entry) => entry.owner.includes('.')))
      .toBe(true);
  });

  it('keeps each mutation transport visibly connected to its AppInbox owner', () => {
    for (const [filePath, markers] of Object.entries(ROUTING_SOURCE_MARKERS)) {
      const source = read(filePath);
      for (const marker of markers) {
        expect(source, `${filePath} must contain ${marker}`).toContain(marker);
      }
    }
  });

  it('has no direct mutator calls or mutating persistence imports at route and WS boundaries', () => {
    expect(findMutationBoundaryViolations()).toEqual([]);
  });

  it('keeps direct boundary exceptions limited to read-only and process-local operations', () => {
    expect([...ALLOWED_DIRECT_BOUNDARY_CALLS].toSorted()).toEqual([
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
  });
});

function route(
  transport: MutationRouteInventoryEntry['transport'],
  entrypoint: string,
  type: AppInboxType,
  owner: string,
): MutationRouteInventoryEntry {
  return { transport, entrypoint, type, owner };
}

function toInventoryKey(entry: MutationRouteInventoryEntry): string {
  return `${entry.transport}:${entry.entrypoint}:${entry.type}`;
}

function read(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}
