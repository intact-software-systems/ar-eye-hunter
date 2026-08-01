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

  it.each([
    {
      name: 'topology to group',
      type: AppInboxType.TOPOLOGY_CONFIG_PUT,
      from: `this.topologyAppInboxHandler.processMutation(
            context,
            requireTopologyManagementService(this.topologyManagementService),
          )`,
      to: 'this.groupStateInboxHandler.processMutation(context)',
    },
    {
      name: 'RTC to group',
      type: AppInboxType.RTC_RTT_SUBMIT,
      from: `this.rtcRttAppInboxHandler.processMutation(
          context,
          this.requireRtcRttAppInboxDependencies(),
        )`,
      to: 'this.groupStateInboxHandler.processMutation(context)',
    },
    {
      name: 'RTC to topology',
      type: AppInboxType.RTC_RTT_SUBMIT,
      from: `this.rtcRttAppInboxHandler.processMutation(
          context,
          this.requireRtcRttAppInboxDependencies(),
        )`,
      to: 'this.topologyAppInboxHandler.processMutation(context)',
    },
    {
      name: 'group to topology',
      type: AppInboxType.GROUP_CREATE,
      from: 'this.groupStateInboxHandler.processMutation(context)',
      to: 'this.topologyAppInboxHandler.processMutation(context)',
    },
    {
      name: 'group to RTC',
      type: AppInboxType.GROUP_CREATE,
      from: 'this.groupStateInboxHandler.processMutation(context)',
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
          await this.topologyAppInboxHandler.processMutation(
            context,
            requireTopologyManagementService(this.topologyManagementService),
          )`,
      to: `async (_payload, context) => {
                    const alias = { topologyAppInboxHandler: this.groupStateInboxHandler };
                    return await alias.topologyAppInboxHandler.processMutation(context);
                }`,
    },
    {
      name: 'RTC',
      type: AppInboxType.RTC_RTT_SUBMIT,
      from: `async (_payload, context) =>
        await this.rtcRttAppInboxHandler.processMutation(
          context,
          this.requireRtcRttAppInboxDependencies(),
        )`,
      to: `async (_payload, context) => {
                const alias = { rtcRttAppInboxHandler: this.groupStateInboxHandler };
                return await alias.rtcRttAppInboxHandler.processMutation(context);
            }`,
    },
    {
      name: 'group',
      type: AppInboxType.GROUP_CREATE,
      from: `const processGroupMutation = async (_payload: unknown, context: AppInboxMessageContext) =>
      await this.groupStateInboxHandler.processMutation(context);`,
      to: `const processGroupMutation = async (_payload: unknown, context: AppInboxMessageContext) => {
      const alias = { groupStateInboxHandler: this.topologyAppInboxHandler };
      return await alias.groupStateInboxHandler.processMutation(context);
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
