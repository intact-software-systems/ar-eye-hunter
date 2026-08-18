import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';

import {
  ALLOWED_DIRECT_BOUNDARY_CALLS,
  findMutationBoundaryViolations,
} from './mutation-boundary-analysis.ts';
import {
  MUTATION_ROUTE_INVENTORY,
  validateMutationRouteInventory,
} from './mutation-routing-inventory.ts';
import { ROUTING_SOURCE_MARKERS } from './mutation-routing-markers.ts';

const GROUP_DISPATCH_PATH = 'packages/shared-server/rallar-system/services/AppGroupInboxService.ts';
const GROUP_MEMBERSHIP_ROUTES = 'apps/api-v1/src/group-state/register-group-membership-routes.ts';
const GROUP_PRESENCE_ROUTES = 'apps/api-v1/src/group-state/register-group-presence-routes.ts';
const GROUP_COMMAND_TRANSLATOR = 'apps/api-v1/src/group-state/to-group-state-command.ts';
const CRDT_ADMIN_ROUTES = 'apps/api-v1/src/routes/crdt-admin-routes.ts';
const CRDT_ADMIN_MUTATIONS = 'apps/api-v1/src/crdt/create-crdt-admin-mutations.ts';

describe('AppInbox mutation routing contract', { timeout: 30_000 }, () => {
  it('inventories every command type with an explicit transport, entrypoint, and owner', () => {
    expect(new Set(MUTATION_ROUTE_INVENTORY.map((entry) => entry.type))).toEqual(
      new Set(Object.values(AppInboxType)),
    );
    expect(validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY)).toEqual([]);
  });

  it('keeps each mutation transport visibly connected to its AppInbox owner', () => {
    for (const [filePath, markers] of Object.entries(ROUTING_SOURCE_MARKERS)) {
      const source = readFileSync(filePath, 'utf8');
      for (const marker of markers) {
        expect(source, `${filePath} must contain ${marker}`).toContain(marker);
      }
    }
  });

  it('rejects a wrong local presence route constant', () => {
    const source = readFileSync(GROUP_PRESENCE_ROUTES, 'utf8');
    const mutated = source.replace(
      "groups/:groupId/sessions/:sessionId';",
      "groups/:groupId/sessions/:sessionId/wrong';",
    );
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(GROUP_PRESENCE_ROUTES, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_PRESENCE_CONNECT registration is absent'),
      ]),
    );
  });

  it('rejects a dead exact registration masking the live named route owner', () => {
    const source = readFileSync(GROUP_PRESENCE_ROUTES, 'utf8');
    const wrongLiveRoute = source.replace(
      '    GROUP_PRESENCE_PATH,',
      '    `${GROUP_PRESENCE_PATH}/wrong`,',
    );
    expect(wrongLiveRoute).not.toBe(source);
    const mutated = `${wrongLiveRoute}
function deadCorrectPresenceRegistration(app: Hono): void {
  app.put(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId',
    async (context) =>
      toGroupStateCommand({
        operation: 'connect-group-presence',
        authSession: context,
      }),
  );
}
`;

    expect(validateWithOverride(GROUP_PRESENCE_ROUTES, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_PRESENCE_CONNECT registration is absent'),
      ]),
    );
  });

  it('rejects an exact route registered only from a request-time callback', () => {
    const source = readFileSync(GROUP_PRESENCE_ROUTES, 'utf8');
    const liveRegistration = `  app.put(
    GROUP_PRESENCE_PATH,
    (context) => handleConnectGroupPresenceRoute(context, dependencies, authorization),
  );`;
    const lateRegistration = `  app.put(
    \`\${GROUP_PRESENCE_PATH}/wrong\`,
    (context) => {
      app.put(
        GROUP_PRESENCE_PATH,
        (lateContext) =>
          handleConnectGroupPresenceRoute(lateContext, dependencies, authorization),
      );
      return handleConnectGroupPresenceRoute(context, dependencies, authorization);
    },
  );`;
    const mutated = source.replace(liveRegistration, lateRegistration);
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(GROUP_PRESENCE_ROUTES, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_PRESENCE_CONNECT registration is absent'),
      ]),
    );
  });

  it('rejects a membership route constant swapped to the presence path', () => {
    const source = readFileSync(GROUP_MEMBERSHIP_ROUTES, 'utf8');
    const mutated = source.replace(
      "groups/:groupId/members/:principalId';",
      "groups/:groupId/sessions/:sessionId';",
    );
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(GROUP_MEMBERSHIP_ROUTES, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_MEMBER_REMOVE registration is absent'),
      ]),
    );
  });

  it('rejects a remove-member route translated through the ban operation', () => {
    const source = readFileSync(GROUP_MEMBERSHIP_ROUTES, 'utf8');
    const mutated = source.replace(
      "operation: 'remove-group-member'",
      "operation: 'ban-group-member'",
    );
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(GROUP_MEMBERSHIP_ROUTES, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_MEMBER_REMOVE operation is not connected'),
      ]),
    );
  });

  it('fails closed when a named route path uses an unknown expression', () => {
    const source = readFileSync(GROUP_PRESENCE_ROUTES, 'utf8');
    const mutated = source.replace(
      "const GROUP_PRESENCE_PATH =\n  '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId';",
      'const GROUP_PRESENCE_PATH = readConfiguredGroupPresencePath();',
    );
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(GROUP_PRESENCE_ROUTES, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_PRESENCE_CONNECT registration is absent'),
      ]),
    );
  });

  it('rejects a translator case routed to another operation type', () => {
    const source = readFileSync(GROUP_COMMAND_TRANSLATOR, 'utf8');
    const mutated = source.replace(
      "case 'remove-group-member':\n      return toRemoveGroupMemberCommand(input);",
      "case 'remove-group-member':\n      return toBanGroupMemberCommand(input);",
    );
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(GROUP_COMMAND_TRANSLATOR, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_MEMBER_REMOVE operation is not connected'),
      ]),
    );
  });

  it('rejects a CRDT route disconnected from the admin mutation intermediary', () => {
    const source = readFileSync(CRDT_ADMIN_ROUTES, 'utf8');
    const mutated = source.replace('writeCrdtAdminMutation({', 'writeCrdtAdminMutationWrong({');
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(CRDT_ADMIN_ROUTES, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('CRDT_SNAPSHOT_COMPACT registered handler is not connected'),
      ]),
    );
  });

  it('rejects an admin mutation intermediary disconnected from terminal AppInbox processing', () => {
    const source = readFileSync(CRDT_ADMIN_MUTATIONS, 'utf8');
    const mutated = source.replace(
      'writeCrdtCommandUntilCompletion(command)',
      'writeCrdtCommandUntilCompletionWrong(command)',
    );
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(CRDT_ADMIN_MUTATIONS, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('CRDT_SNAPSHOT_COMPACT registered handler is not connected'),
      ]),
    );
  });

  it.each([
    {
      name: 'topology to group',
      type: AppInboxType.TOPOLOGY_CONFIG_PUT,
      from: 'this.topologyAppInboxHandler.processMutation(context, owners)',
      to: 'this.groupStateInboxHandler.processGroupStateMutation(context)',
    },
    {
      name: 'RTC to group',
      type: AppInboxType.RTC_RTT_SUBMIT,
      from: 'this.rtcRttAppInboxHandler.processMutation(context, dependencies)',
      to: 'this.groupStateInboxHandler.processGroupStateMutation(context)',
    },
    {
      name: 'RTC to topology',
      type: AppInboxType.RTC_RTT_SUBMIT,
      from: 'this.rtcRttAppInboxHandler.processMutation(context, dependencies)',
      to: 'this.topologyAppInboxHandler.processMutation(context)',
    },
    {
      name: 'group to topology',
      type: AppInboxType.GROUP_CREATE,
      from: 'this.groupStateInboxHandler.processGroupStateMutation(context)',
      to: 'this.topologyAppInboxHandler.processMutation(context)',
    },
    {
      name: 'group to RTC',
      type: AppInboxType.GROUP_CREATE,
      from: 'this.groupStateInboxHandler.processGroupStateMutation(context)',
      to: 'this.rtcRttAppInboxHandler.processMutation(context)',
    },
  ])('rejects $name cross-routing despite the shared terminal method', ({ type, from, to }) => {
    const source = readFileSync(GROUP_DISPATCH_PATH, 'utf8');
    const mutated = source.replace(from, to);
    expect(mutated).not.toBe(source);
    const route = MUTATION_ROUTE_INVENTORY.find((entry) => entry.type === type);
    expect(route).toBeDefined();

    expect(
      validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
        sourceOverrides: new Map([[GROUP_DISPATCH_PATH, mutated]]),
      }),
    ).toContain(
      `${route!.transport}:${route!.entrypoint}:${route!.type} ` +
        `owner dispatch is not connected to ${route!.owner}`,
    );
  });

  it.each([
    {
      name: 'topology',
      type: AppInboxType.TOPOLOGY_CONFIG_PUT,
      from: `async (_payload, context) =>
          await this.topologyAppInboxHandler.processMutation(context, owners)`,
      to: `async (_payload, context) => {
                    const alias = { topologyAppInboxHandler: this.groupStateInboxHandler };
                    return await alias.topologyAppInboxHandler.processMutation(context);
                }`,
    },
    {
      name: 'RTC',
      type: AppInboxType.RTC_RTT_SUBMIT,
      from: `async (_payload, context) =>
        await this.rtcRttAppInboxHandler.processMutation(context, dependencies)`,
      to: `async (_payload, context) => {
                const alias = { rtcRttAppInboxHandler: this.groupStateInboxHandler };
                return await alias.rtcRttAppInboxHandler.processMutation(context);
            }`,
    },
    {
      name: 'group',
      type: AppInboxType.GROUP_CREATE,
      from: `const processGroupMutation = async (_payload: unknown, context: AppInboxMessageContext) =>
      await this.groupStateInboxHandler.processGroupStateMutation(context);`,
      to: `const processGroupMutation = async (_payload: unknown, context: AppInboxMessageContext) => {
      const alias = { groupStateInboxHandler: this.topologyAppInboxHandler };
      return await alias.groupStateInboxHandler.processGroupStateMutation(context);
    };`,
    },
  ])('rejects a $name alias receiver backed by the wrong handler', ({ type, from, to }) => {
    const source = readFileSync(GROUP_DISPATCH_PATH, 'utf8');
    const mutated = source.replace(from, to);
    expect(mutated).not.toBe(source);
    const route = MUTATION_ROUTE_INVENTORY.find((entry) => entry.type === type);
    expect(route).toBeDefined();

    expect(
      validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
        sourceOverrides: new Map([[GROUP_DISPATCH_PATH, mutated]]),
      }),
    ).toContain(
      `${route!.transport}:${route!.entrypoint}:${route!.type} ` +
        `owner dispatch is not connected to ${route!.owner}`,
    );
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

function validateWithOverride(filePath: string, source: string): readonly string[] {
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[filePath, source]]),
  });
}
