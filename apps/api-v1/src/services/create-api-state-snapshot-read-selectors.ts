import type { StateSnapshotReadDiagnosticEvent } from '@shared/api/state-snapshot-read.ts';
import {
  type ClientRestSnapshotReadSelectorDependencies,
  createClientRestSnapshotReadSelector,
} from '@shared-server/rallar-system/client-state/snapshot/client-rest-snapshot-read-selector.ts';
import {
  createGroupRestSnapshotReadSelector,
  type GroupRestSnapshotReadSelectorDependencies,
} from '@shared-server/rallar-system/group-state/snapshot/group-rest-snapshot-read-selector.ts';
import {
  type RallarTimingSink,
  recordRallarTiming,
} from '@shared-server/rallar-system/services/timing.ts';

export interface ApiStateSnapshotReadSelectors {
  readonly clientRestSnapshotReadSelector: ReturnType<
    typeof createClientRestSnapshotReadSelector
  >;
  readonly groupRestSnapshotReadSelector: ReturnType<
    typeof createGroupRestSnapshotReadSelector
  >;
}

export function createApiStateSnapshotReadSelectors(
  input: Readonly<{
    clientDurable: ClientRestSnapshotReadSelectorDependencies['durable'];
    clientCache: ClientRestSnapshotReadSelectorDependencies['cache'];
    groupDurable: GroupRestSnapshotReadSelectorDependencies['durable'];
    groupCache: GroupRestSnapshotReadSelectorDependencies['cache'];
  }>,
  timing: RallarTimingSink,
): ApiStateSnapshotReadSelectors {
  const diagnostics = createDiagnostics(timing);
  return {
    clientRestSnapshotReadSelector: createClientRestSnapshotReadSelector({
      durable: input.clientDurable,
      cache: input.clientCache,
      diagnostics,
    }),
    groupRestSnapshotReadSelector: createGroupRestSnapshotReadSelector({
      durable: input.groupDurable,
      cache: input.groupCache,
      diagnostics,
    }),
  };
}

function createDiagnostics(timing: RallarTimingSink) {
  return (event: StateSnapshotReadDiagnosticEvent) => {
    recordRallarTiming(
      timing,
      {
        component: 'rest-state-snapshot-read',
        operation: event.name,
        details: {
          source: event.source,
          result: event.result,
          floorOutcome: event.floorOutcome,
          cleanupOutcome: event.cleanupOutcome,
          strictMode: event.strictMode,
        },
      },
      event.result === 'error' ? 'error' : 'ok',
      event.durationMs,
    );
  };
}
