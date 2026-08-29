import type { GroupTopologyManagementView } from '@shared/api/graph-topology-management-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { toOverlayInfoForSession } from '@shared/api/overlay-topology.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { OverlayAdoptionOutcome } from '@shared/repository/overlays-repository.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import type { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';

import type { ApiRequestOptions } from '../api/http-request.ts';
import { readStateGroupTopology } from '../rtc/rtc-topology-http-api.ts';
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
    input: HydrateGroupTopologyOverlaysInput
): Promise<readonly GroupTopologyReadThrough[]> {
    const joinedGroups = input.groupSnapshots.filter((snapshot) =>
        snapshot.activeSessions.some((session) => session.sessionId === input.sessionId)
    );
    return await Promise.all(
        joinedGroups.map((snapshot) => readThroughGroupTopology(snapshot.group.groupId, input))
    );
}

async function readThroughGroupTopology(
    groupId: string,
    input: HydrateGroupTopologyOverlaysInput
): Promise<GroupTopologyReadThrough> {
    const startedAtMs = Date.now();
    let outcome: GroupTopologyReadThroughOutcome;
    try {
        const view = await readStateGroupTopology(groupId, input.scope, input.apiRequest);
        const hydration = hydrateCurrentTopologyRoles(view, input.sessionId);
        await Promise.all([
            overlaysRepository.waitForPlannedOverlayChangesIdle(),
            overlaysRepository.waitForAcceptedOverlayChangesIdle()
        ]);
        if (hydration.changed) {
            await input.webRtcGroupManager.notifyOverlayTopologyChanged();
        }
        outcome = hydration.conflicted
            ? 'revision-conflict'
            : view.snapshot === null && view.acceptedSnapshot === null
            ? 'no-overlay'
            : 'adopted';
    }
    catch (error) {
        // Read-through is best-effort anti-entropy: WS relay stays the correctness
        // baseline, so a failed pull must not break connect or reconnect.
        outcome = 'read-failed';
        console.warn(`Group topology read-through ${outcome} for group ${groupId}`, error);
    }
    emitBrowserStateReadDiagnostic({
        name: 'rallar.browser.state-read',
        feature: 'group',
        operation: 'topology-read-through',
        result: outcome,
        durationMs: Date.now() - startedAtMs
    });
    return { groupId, outcome };
}

interface CurrentTopologyRoleHydration {
    readonly changed: boolean;
    readonly conflicted: boolean;
}

function hydrateCurrentTopologyRoles(
    view: GroupTopologyManagementView,
    sessionId: string
): CurrentTopologyRoleHydration {
    const plannedOutcome = view.snapshot === null
        ? undefined
        : overlaysRepository.setCurrentPlannedServerOverlayById(
            view.overlayId,
            toOverlayInfoForSession(view.snapshot, sessionId)
        );
    const acceptedOutcome = view.acceptedSnapshot === null
        ? undefined
        : overlaysRepository.setCurrentAcceptedServerOverlayById(
            view.overlayId,
            toOverlayInfoForSession(view.acceptedSnapshot, sessionId)
        );
    const removedPlanned = view.snapshot === null
        ? overlaysRepository.removePlannedOverlayById(view.overlayId)
        : false;
    const removedAccepted = view.acceptedSnapshot === null
        ? overlaysRepository.removeAcceptedOverlayById(view.overlayId)
        : false;

    return {
        changed: didCurrentTopologyHydrationChange(plannedOutcome) ||
            didCurrentTopologyHydrationChange(acceptedOutcome) ||
            removedPlanned ||
            removedAccepted,
        conflicted: plannedOutcome === 'incomparable-conflict' ||
            acceptedOutcome === 'incomparable-conflict'
    };
}

function didCurrentTopologyHydrationChange(
    outcome: OverlayAdoptionOutcome | undefined
): boolean {
    return outcome !== undefined && overlaysRepository.didOverlayAdoptionChange(outcome);
}
