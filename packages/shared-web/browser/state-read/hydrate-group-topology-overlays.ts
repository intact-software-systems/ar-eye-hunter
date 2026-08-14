import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { OverlayRevisionConflictError } from '@shared/repository/overlays-repository.ts';
import type { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';

import type { ApiRequestOptions } from '../api-integration.ts';
import { readStateGroupTopology } from '../api-integration.ts';
import { acceptServerOverlayTopology } from '../data-caches.ts';
import { emitBrowserStateReadDiagnostic } from './diagnostics.ts';

export interface HydrateGroupTopologyOverlaysInput {
  readonly groupSnapshots: readonly GroupSnapshot[];
  readonly sessionId: string;
  readonly webRtcGroupManager: WebRtcGroupManager;
  readonly scope: StateScope;
  readonly apiRequest: ApiRequestOptions;
}

export type GroupTopologyReadThroughOutcome =
  | 'adopted'
  | 'no-overlay'
  | 'revision-conflict'
  | 'read-failed';

export interface GroupTopologyReadThrough {
  readonly groupId: string;
  readonly outcome: GroupTopologyReadThroughOutcome;
}

export async function hydrateGroupTopologyOverlays(
  input: HydrateGroupTopologyOverlaysInput,
): Promise<readonly GroupTopologyReadThrough[]> {
  const joinedGroups = input.groupSnapshots.filter((snapshot) =>
    snapshot.activeSessions.some((session) => session.sessionId === input.sessionId),
  );
  return await Promise.all(
    joinedGroups.map((snapshot) => readThroughGroupTopology(snapshot.group.groupId, input)),
  );
}

async function readThroughGroupTopology(
  groupId: string,
  input: HydrateGroupTopologyOverlaysInput,
): Promise<GroupTopologyReadThrough> {
  const startedAtMs = Date.now();
  let outcome: GroupTopologyReadThroughOutcome;
  try {
    const view = await readStateGroupTopology(groupId, input.scope, input.apiRequest);
    if (view.snapshot === null) {
      outcome = 'no-overlay';
    } else {
      await acceptServerOverlayTopology({
        topology: view.snapshot,
        sessionId: input.sessionId,
        webRtcGroupManager: input.webRtcGroupManager,
        adoption: 'current-state',
      });
      outcome = 'adopted';
    }
  } catch (error) {
    // Read-through is best-effort anti-entropy: WS relay stays the correctness
    // baseline, so a failed pull must not break connect or reconnect.
    outcome = error instanceof OverlayRevisionConflictError ? 'revision-conflict' : 'read-failed';
    console.warn(`Group topology read-through ${outcome} for group ${groupId}`, error);
  }
  emitBrowserStateReadDiagnostic({
    name: 'rallar.browser.state-read',
    feature: 'group',
    operation: 'topology-read-through',
    result: outcome,
    durationMs: Date.now() - startedAtMs,
  });
  return { groupId, outcome };
}
