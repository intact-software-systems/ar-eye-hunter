import type { OverlayInfo } from '@shared/api/api-config.ts';
import { isSameGroupRef, toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeOverlayTopologySnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupTopologyManagementView } from '@shared/api/graph-topology-management-types.ts';
import { isGroupActive, isSessionInGroup } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { toOverlayInfoForSession, type RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { validateRallarGroupRef } from '@shared/api/rallar-validation.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
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
        joinedGroups.map((snapshot) => readThroughGroupTopology(snapshot, input))
    );
}

async function readThroughGroupTopology(
    groupSnapshot: GroupSnapshot,
    input: HydrateGroupTopologyOverlaysInput
): Promise<GroupTopologyReadThrough> {
    const groupId = groupSnapshot.group.groupId;
    const startedAtMs = Date.now();
    let outcome: GroupTopologyReadThroughOutcome;
    try {
        const observations = readCurrentTopologyRoleObservations(
            toScopedOverlayId(groupSnapshot.group)
        );
        const view = validateGroupTopologyManagementView(
            await readStateGroupTopology(groupId, input.scope, input.apiRequest),
            groupId,
            input.scope
        );
        const latestGroup = groupStateSnapshotsRepository.findGroupStateSnapshotByRef(
            groupSnapshot.group
        );
        if (
            latestGroup === undefined ||
            !isGroupActive(latestGroup) ||
            !isSessionInGroup(latestGroup, input.sessionId)
        ) {
            outcome = 'no-overlay';
            return emitReadThroughOutcome(groupId, outcome, startedAtMs);
        }

        const hydration = hydrateCurrentTopologyRoles(view, input.sessionId, observations);
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
    return emitReadThroughOutcome(groupId, outcome, startedAtMs);
}

function emitReadThroughOutcome(
    groupId: string,
    outcome: GroupTopologyReadThroughOutcome,
    startedAtMs: number
): GroupTopologyReadThrough {
    emitBrowserStateReadDiagnostic({
        name: 'rallar.browser.state-read',
        feature: 'group',
        operation: 'topology-read-through',
        result: outcome,
        durationMs: Date.now() - startedAtMs
    });
    return { groupId, outcome };
}

interface ValidatedGroupTopologyView {
    readonly groupRef: GroupRef;
    readonly overlayId: string;
    readonly snapshot: RallarOverlayTopologySnapshot | null;
    readonly acceptedSnapshot: RallarOverlayTopologySnapshot | null;
}

interface CurrentTopologyRoleObservations {
    readonly overlayId: string;
    readonly planned: OverlayInfo | undefined;
    readonly accepted: OverlayInfo | undefined;
}

interface ValidateTopologyRoleSnapshotInput {
    readonly value: RallarOverlayTopologySnapshot | null;
    readonly groupRef: GroupRef;
    readonly overlayId: string;
    readonly scope: StateScope;
    readonly role: 'snapshot' | 'acceptedSnapshot';
}

interface CurrentTopologyRoleHydration {
    readonly changed: boolean;
    readonly conflicted: boolean;
}

function hydrateCurrentTopologyRoles(
    view: ValidatedGroupTopologyView,
    sessionId: string,
    observations: CurrentTopologyRoleObservations
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
        ? overlaysRepository.removePlannedOverlayByIdIfUnchanged(
            observations.overlayId,
            observations.planned
        )
        : false;
    const removedAccepted = view.acceptedSnapshot === null
        ? overlaysRepository.removeAcceptedOverlayByIdIfUnchanged(
            observations.overlayId,
            observations.accepted
        )
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

function readCurrentTopologyRoleObservations(
    overlayId: string
): CurrentTopologyRoleObservations {
    return {
        overlayId,
        planned: overlaysRepository.findPlannedOverlayById(overlayId),
        accepted: overlaysRepository.findAcceptedOverlayById(overlayId)
    };
}

function validateGroupTopologyManagementView(
    value: GroupTopologyManagementView,
    requestedGroupId: string,
    scope: StateScope
): ValidatedGroupTopologyView {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('Group topology view must be an object');
    }
    const groupRefValidation = validateRallarGroupRef(
        value.groupRef,
        'GroupTopologyManagementView.groupRef'
    );
    if (!groupRefValidation.ok) {
        throw new TypeError(groupRefValidation.errors.join('; '));
    }
    const groupRef = value.groupRef;
    const requestedGroupRef: GroupRef = {
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        groupId: requestedGroupId
    };
    if (!isSameGroupRef(groupRef, requestedGroupRef)) {
        throw new TypeError('Group topology view groupRef differs from the requested group');
    }
    const overlayId = toScopedOverlayId(requestedGroupRef);
    if (value.overlayId !== overlayId) {
        throw new TypeError('Group topology view overlayId is not canonical for the requested group');
    }

    return {
        groupRef,
        overlayId,
        snapshot: validateTopologyRoleSnapshot({
            value: value.snapshot,
            groupRef,
            overlayId,
            scope,
            role: 'snapshot'
        }),
        acceptedSnapshot: validateTopologyRoleSnapshot({
            value: value.acceptedSnapshot,
            groupRef,
            overlayId,
            scope,
            role: 'acceptedSnapshot'
        })
    };
}

function validateTopologyRoleSnapshot(
    input: ValidateTopologyRoleSnapshotInput
): RallarOverlayTopologySnapshot | null {
    if (input.value === null) {
        return null;
    }
    validateAuthoritativeOverlayTopologySnapshot(input.value, input.scope);
    if (
        input.value.overlayId !== input.overlayId ||
        !isSameGroupRef(input.value.groupRef, input.groupRef)
    ) {
        throw new TypeError(
            `Group topology view ${input.role} identity differs from its outer view`
        );
    }
    return input.value;
}

function didCurrentTopologyHydrationChange(
    outcome: OverlayAdoptionOutcome | undefined
): boolean {
    return outcome !== undefined && overlaysRepository.didOverlayAdoptionChange(outcome);
}
