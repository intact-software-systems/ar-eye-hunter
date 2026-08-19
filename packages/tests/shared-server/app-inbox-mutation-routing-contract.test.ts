import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

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
const CRDT_ADMIN_ROUTES = 'apps/api-v1/src/crdt/register-crdt-admin-routes.ts';
const CRDT_ADMIN_MUTATIONS = 'apps/api-v1/src/crdt/create-crdt-admin-mutations.ts';
const ADMIN_MUTATION_GATEWAY = 'apps/api-v1/src/services/create-api-admin-mutation-gateway.ts';
const APP_CRDT_INBOX = 'packages/shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts';

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
    expect.arrayContaining([expect.stringContaining('GROUP_MEMBER_REMOVE registration is absent')]),
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
    'const GROUP_PRESENCE_PATH =\n' +
      "  '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/" +
      ":groupId/sessions/:sessionId';",
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

it('rejects an admin intermediary disconnected from terminal AppInbox processing', () => {
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
    name: 'direct CRDT route',
    filePath: CRDT_ADMIN_ROUTES,
    from: "operation: 'compact',",
    to: "operation: 'lifecycle',",
  },
  {
    name: 'general admin gateway',
    filePath: ADMIN_MUTATION_GATEWAY,
    from: "operation: 'compact',",
    to: "operation: 'lifecycle',",
  },
])('rejects compact rerouted to lifecycle through the $name', ({ filePath, from, to }) => {
  const source = readFileSync(filePath, 'utf8');
  const mutated = source.replace(from, to);
  expect(mutated).not.toBe(source);

  expect(validateWithOverride(filePath, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('rejects compact command construction rerouted to the lifecycle operation', () => {
  const source = readFileSync(CRDT_ADMIN_MUTATIONS, 'utf8');
  const mutated = replaceWithinSwitchCase({
    source,
    caseName: 'compact',
    followingCaseName: 'lifecycle',
    from: 'operation: input.operation,',
    to: "operation: 'lifecycle',",
  });

  expect(validateWithOverride(CRDT_ADMIN_MUTATIONS, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('rejects compact mapped to the lifecycle AppInbox type', () => {
  const source = readFileSync(APP_CRDT_INBOX, 'utf8');
  const mutated = replaceWithinSwitchCase({
    source,
    caseName: 'compact',
    followingCaseName: 'lifecycle',
    from: 'return AppInboxType.CRDT_SNAPSHOT_COMPACT;',
    to: 'return AppInboxType.CRDT_LIFECYCLE_UPDATE;',
  });

  expect(validateWithOverride(APP_CRDT_INBOX, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('rejects a hardcoded lifecycle operation in the direct forwarding helper', () => {
  const source = readFileSync(CRDT_ADMIN_ROUTES, 'utf8');
  const mutated = replaceRequired(source, 'operation: input.operation,', "operation: 'lifecycle',");
  expect(mutated).not.toBe(source);

  expect(validateWithOverride(CRDT_ADMIN_ROUTES, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('rejects a correct command followed by submission of a lifecycle command', () => {
  const source = readFileSync(CRDT_ADMIN_MUTATIONS, 'utf8');
  const mutated = withSecondLifecycleCommandSubmission(source);

  expect(validateWithOverride(CRDT_ADMIN_MUTATIONS, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('rejects a dead compact type return followed by live lifecycle fallthrough', () => {
  const source = readFileSync(APP_CRDT_INBOX, 'utf8');
  const mutated = replaceWithinSwitchCase({
    source,
    caseName: 'compact',
    followingCaseName: 'lifecycle',
    from: 'return AppInboxType.CRDT_SNAPSHOT_COMPACT;',
    to: 'if (false) {\n        return AppInboxType.CRDT_SNAPSHOT_COMPACT;\n      }',
  });

  expect(validateWithOverride(APP_CRDT_INBOX, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('rejects a dead correct compact builder masking the live lifecycle builder', () => {
  const source = readFileSync(CRDT_ADMIN_MUTATIONS, 'utf8');
  const mutated = withDeadCorrectCompactCommandCreation(source);

  expect(validateWithOverride(CRDT_ADMIN_MUTATIONS, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('rejects a dead correct direct call masking the live lifecycle route call', () => {
  const source = readFileSync(CRDT_ADMIN_ROUTES, 'utf8');
  const mutated = withDeadCorrectDirectRouteCall(source);

  expect(validateWithOverride(CRDT_ADMIN_ROUTES, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('rejects a dead correct gateway call masking the live lifecycle call', () => {
  const source = readFileSync(ADMIN_MUTATION_GATEWAY, 'utf8');
  const mutated = withDeadCorrectGatewayCall(source);

  expect(validateWithOverride(ADMIN_MUTATION_GATEWAY, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('rejects live reassignment of the submitted command to lifecycle', () => {
  const source = readFileSync(CRDT_ADMIN_MUTATIONS, 'utf8');
  const mutated = withLiveLifecycleCommandReassignment(source);

  expect(validateWithOverride(CRDT_ADMIN_MUTATIONS, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('ignores a command reassignment in a dead branch', () => {
  const source = readFileSync(CRDT_ADMIN_MUTATIONS, 'utf8');
  const mutated = withDeadLifecycleCommandReassignment(source);

  expect(validateWithOverride(CRDT_ADMIN_MUTATIONS, mutated)).toEqual([]);
});

it('rejects a later nested compact command shadowing the submitted lifecycle command', () => {
  const source = readFileSync(CRDT_ADMIN_MUTATIONS, 'utf8');
  const mutated = withLaterNestedCompactCommandShadow(source);

  expect(validateWithOverride(CRDT_ADMIN_MUTATIONS, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('accepts canonical command submission inside one nested lexical block', () => {
  const source = readFileSync(CRDT_ADMIN_MUTATIONS, 'utf8');
  const mutated = withNestedCanonicalCommandScope(source);

  expect(validateWithOverride(CRDT_ADMIN_MUTATIONS, mutated)).toEqual([]);
});

it('rejects a callback parameter shadowing the outer compact command', () => {
  const source = readFileSync(CRDT_ADMIN_MUTATIONS, 'utf8');
  const mutated = withLifecycleCommandSubmittedThroughShadowingParameter(source);

  expect(validateWithOverride(CRDT_ADMIN_MUTATIONS, mutated)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('CRDT_SNAPSHOT_COMPACT operation is not connected'),
    ]),
  );
});

it('accepts an unrelated callback parameter while submitting the outer command', () => {
  const source = readFileSync(CRDT_ADMIN_MUTATIONS, 'utf8');
  const mutated = withOuterCommandSubmittedBesideUnrelatedParameter(source);

  expect(validateWithOverride(CRDT_ADMIN_MUTATIONS, mutated)).toEqual([]);
});

it.each([
  ['/api/crdt/admin/documents/compact', AppInboxType.CRDT_SNAPSHOT_COMPACT, 'compact'],
  ['/api/admin/operations/crdt/compact', AppInboxType.CRDT_SNAPSHOT_COMPACT, 'compact'],
  ['/api/crdt/admin/documents/lifecycle', AppInboxType.CRDT_LIFECYCLE_UPDATE, 'lifecycle'],
  ['/api/admin/operations/crdt/lifecycle', AppInboxType.CRDT_LIFECYCLE_UPDATE, 'lifecycle'],
  ['/api/crdt/admin/documents/erase', AppInboxType.CRDT_ERASE, 'erase'],
  ['/api/admin/operations/crdt/erase', AppInboxType.CRDT_ERASE, 'erase'],
])('inventories %s with its exact operation and AppInbox type', (route, type, operation) => {
  expect(MUTATION_ROUTE_INVENTORY.find((entry) => entry.entrypoint.includes(route))).toEqual(
    expect.objectContaining({ type, operationDiscriminant: operation }),
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
  if (!route) {
    throw new Error(`Missing route inventory for ${type}`);
  }

  expect(
    validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
      sourceOverrides: new Map([[GROUP_DISPATCH_PATH, mutated]]),
    }),
  ).toContain(
    `${route.transport}:${route.entrypoint}:${route.type} ` +
      `owner dispatch is not connected to ${route.owner}`,
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
    from:
      'const processGroupMutation = async ' +
      '(_payload: unknown, context: AppInboxMessageContext) =>\n' +
      '      await this.groupStateInboxHandler.processGroupStateMutation(context);',
    to:
      'const processGroupMutation = async ' +
      '(_payload: unknown, context: AppInboxMessageContext) => {\n' +
      '      const alias = { groupStateInboxHandler: this.topologyAppInboxHandler };\n' +
      '      return await alias.groupStateInboxHandler.processGroupStateMutation(context);\n' +
      '    };',
  },
])('rejects a $name alias receiver backed by the wrong handler', ({ type, from, to }) => {
  const source = readFileSync(GROUP_DISPATCH_PATH, 'utf8');
  const mutated = source.replace(from, to);
  expect(mutated).not.toBe(source);
  const route = MUTATION_ROUTE_INVENTORY.find((entry) => entry.type === type);
  if (!route) {
    throw new Error(`Missing route inventory for ${type}`);
  }

  expect(
    validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
      sourceOverrides: new Map([[GROUP_DISPATCH_PATH, mutated]]),
    }),
  ).toContain(
    `${route.transport}:${route.entrypoint}:${route.type} ` +
      `owner dispatch is not connected to ${route.owner}`,
  );
});

it(
  'has no direct mutators or persistence imports at route and WS boundaries',
  { timeout: 15_000 },
  () => {
    expect(findMutationBoundaryViolations()).toEqual([]);
  },
);

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
function validateWithOverride(filePath: string, source: string): readonly string[] {
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[filePath, source]]),
  });
}

interface ReplaceWithinSwitchCaseInput {
  readonly source: string;
  readonly caseName: string;
  readonly followingCaseName: string;
  readonly from: string;
  readonly to: string;
}

function replaceWithinSwitchCase(input: ReplaceWithinSwitchCaseInput): string {
  const caseStart = input.source.indexOf(`case '${input.caseName}':`);
  const caseEnd = input.source.indexOf(`case '${input.followingCaseName}':`, caseStart);
  if (caseStart < 0 || caseEnd < 0) {
    throw new Error(`Switch case ${input.caseName} is absent`);
  }
  const caseSource = input.source.slice(caseStart, caseEnd);
  const mutatedCase = caseSource.replace(input.from, input.to);
  if (mutatedCase === caseSource) {
    throw new Error(`Switch case ${input.caseName} does not contain the expected mapping`);
  }
  return input.source.slice(0, caseStart) + mutatedCase + input.source.slice(caseEnd);
}

function withSecondLifecycleCommandSubmission(source: string): string {
  const original =
    '      const completed = await input.appCrdtInboxService.' +
    'writeCrdtCommandUntilCompletion(command);';
  const replacement = `      const lifecycleCommand = await createCrdtAdminCommand({
        ...mutation,
        operation: 'lifecycle',
        nowEpochMs: input.nowEpochMs,
        createId: input.createId,
        serviceId: input.serviceId,
      });
      const completed = await input.appCrdtInboxService.writeCrdtCommandUntilCompletion(
        lifecycleCommand,
      );`;
  return replaceRequired(source, original, replacement);
}

function withLiveLifecycleCommandReassignment(source: string): string {
  const mutable = replaceRequired(
    source,
    '      const command = await createCrdtAdminCommand({',
    '      let command = await createCrdtAdminCommand({',
  );
  const submission =
    '      const completed = await input.appCrdtInboxService.' +
    'writeCrdtCommandUntilCompletion(command);';
  const replacement = `      command = await createCrdtAdminCommand({
        ...mutation,
        operation: 'lifecycle',
        nowEpochMs: input.nowEpochMs,
        createId: input.createId,
        serviceId: input.serviceId,
      });
${submission}`;
  return replaceRequired(mutable, submission, replacement);
}

function withDeadLifecycleCommandReassignment(source: string): string {
  const submission =
    '      const completed = await input.appCrdtInboxService.' +
    'writeCrdtCommandUntilCompletion(command);';
  const replacement = `      if (false) {
        command = await createCrdtAdminCommand({
          ...mutation,
          operation: 'lifecycle',
          nowEpochMs: input.nowEpochMs,
          createId: input.createId,
          serviceId: input.serviceId,
        });
      }
${submission}`;
  return replaceRequired(source, submission, replacement);
}

function withLaterNestedCompactCommandShadow(source: string): string {
  const wrongSubmittedCommand = replaceRequired(
    source,
    '        ...mutation,\n        nowEpochMs: input.nowEpochMs,',
    "        ...mutation,\n        operation: 'lifecycle',\n        nowEpochMs: input.nowEpochMs,",
  );
  const submission =
    '      const completed = await input.appCrdtInboxService.' +
    'writeCrdtCommandUntilCompletion(command);';
  const replacement = `${submission}
      {
        const command = await createCrdtAdminCommand({
          ...mutation,
          operation: 'compact',
          nowEpochMs: input.nowEpochMs,
          createId: input.createId,
          serviceId: input.serviceId,
        });
        void command;
      }`;
  return replaceRequired(wrongSubmittedCommand, submission, replacement);
}

function withNestedCanonicalCommandScope(source: string): string {
  const opened = replaceRequired(
    source,
    '    writeCrdtAdminMutation: async (mutation) => {\n      const command',
    '    writeCrdtAdminMutation: async (mutation) => {\n      {\n        const command',
  );
  return replaceRequired(
    opened,
    '      return toAdminPublicResult(result);\n    },',
    '      return toAdminPublicResult(result);\n      }\n    },',
  );
}

function withLifecycleCommandSubmittedThroughShadowingParameter(source: string): string {
  const submission =
    '      const completed = await input.appCrdtInboxService.' +
    'writeCrdtCommandUntilCompletion(command);';
  const replacement = `      const submitCommand = async (command: CrdtMutationCommand) =>
        await input.appCrdtInboxService.writeCrdtCommandUntilCompletion(command);
      const lifecycleCommand = await createCrdtAdminCommand({
        ...mutation,
        operation: 'lifecycle',
        nowEpochMs: input.nowEpochMs,
        createId: input.createId,
        serviceId: input.serviceId,
      });
      const completed = await submitCommand(lifecycleCommand);`;
  return replaceRequired(source, submission, replacement);
}

function withOuterCommandSubmittedBesideUnrelatedParameter(source: string): string {
  const submission =
    '      const completed = await input.appCrdtInboxService.' +
    'writeCrdtCommandUntilCompletion(command);';
  const replacement = `      const submitCommand = async (_candidate: CrdtMutationCommand) =>
        await input.appCrdtInboxService.writeCrdtCommandUntilCompletion(command);
      const completed = await submitCommand(command);`;
  return replaceRequired(source, submission, replacement);
}

function withDeadCorrectCompactCommandCreation(source: string): string {
  const caseSource = readSwitchCaseSource(source, 'compact', 'lifecycle');
  const returnStart = caseSource.indexOf('      return await createCrdtMutationCommand({');
  const returnEnd = caseSource.indexOf('\n    }', returnStart);
  if (returnStart < 0 || returnEnd < 0) {
    throw new Error('Compact command return is absent');
  }
  const correctReturn = caseSource.slice(returnStart, returnEnd);
  const nestedCorrectReturn = correctReturn.replace(/^      /gm, '        ');
  const wrongReturn = correctReturn.replace(
    'operation: input.operation,',
    "operation: 'lifecycle',",
  );
  const replacement = `      if (false) {
${nestedCorrectReturn}
      }
${wrongReturn}`;
  return replaceRequired(source, correctReturn, replacement);
}

function withDeadCorrectDirectRouteCall(source: string): string {
  const correctCall = `      return await processCrdtAdminMutation({
        context,
        dependencies,
        operation: 'compact',
        request: await readJson(context),
      });`;
  const nestedCorrectCall = correctCall.replace(/^      /gm, '        ');
  const wrongCall = correctCall.replace("operation: 'compact',", "operation: 'lifecycle',");
  return replaceRequired(
    source,
    correctCall,
    `      if (false) {
${nestedCorrectCall}
      }
${wrongCall}`,
  );
}

function withDeadCorrectGatewayCall(source: string): string {
  const original = `    compactCrdt: async (request) =>
      requireCrdtCompactResult(
        await input.crdtAdminMutations.writeCrdtAdminMutation({
          operation: 'compact',
          adminSession: request.adminSession,
          request: request.request,
        }),
      ),`;
  const replacement = `    compactCrdt: async (request) => {
      if (false) {
        return requireCrdtCompactResult(
          await input.crdtAdminMutations.writeCrdtAdminMutation({
            operation: 'compact',
            adminSession: request.adminSession,
            request: request.request,
          }),
        );
      }
      return requireCrdtCompactResult(
        await input.crdtAdminMutations.writeCrdtAdminMutation({
          operation: 'lifecycle',
          adminSession: request.adminSession,
          request: request.request,
        }),
      );
    },`;
  return replaceRequired(source, original, replacement);
}

function readSwitchCaseSource(source: string, caseName: string, followingCaseName: string): string {
  const caseStart = source.indexOf(`case '${caseName}':`);
  const caseEnd = source.indexOf(`case '${followingCaseName}':`, caseStart);
  if (caseStart < 0 || caseEnd < 0) {
    throw new Error(`Switch case ${caseName} is absent`);
  }
  return source.slice(caseStart, caseEnd);
}

function replaceRequired(source: string, from: string, to: string): string {
  const replaced = source.replace(from, to);
  if (replaced === source) {
    throw new Error(`Expected source fragment is absent: ${from}`);
  }
  return replaced;
}
