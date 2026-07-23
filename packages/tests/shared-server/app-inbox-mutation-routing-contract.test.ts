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

describe('AppInbox mutation routing contract', () => {
  it('inventories every command type with an explicit transport, entrypoint, and owner', () => {
    expect(new Set(MUTATION_ROUTE_INVENTORY.map((entry) => entry.type)))
      .toEqual(new Set(Object.values(AppInboxType)));
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
