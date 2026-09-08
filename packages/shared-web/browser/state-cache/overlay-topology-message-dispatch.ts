import { AppTopics } from '@shared/api/api-config.ts';
import { parseAuthoritativeOverlayTopologySnapshot } from '@shared/api/authoritative-state-validation.ts';
import { isGroupActive, isSessionInGroup } from '@shared/api/group-client-views.ts';
import {
    resolveGroupLayoutRole,
    toGroupLayoutIdentity,
    type GroupLayoutRole
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { toOverlayInfoForSession, type RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { CompletedStateSnapshot } from '@shared/api/state-snapshot-page.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import {
    findGroupStateSnapshotByRef,
    wasGroupStateSnapshotObservedByRef
} from '@shared/repository/group-state-snapshots-repository.ts';
import { emitOverlayAdoption, type OverlayAdoptionOutcome } from '@shared/repository/overlay-adoption-diagnostics.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import type { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';

import { isRtcTopologyCurrentStateMessage } from './is-rtc-topology-current-state-message.ts';

export interface AdoptOverlayTopologyInput {
    readonly topology: RallarOverlayTopologySnapshot;
    readonly sessionId: string;
    readonly webRtcGroupManager: Pick<WebRtcGroupManager, 'notifyOverlayTopologyChanged'>;
    readonly adoption: 'current-state' | 'publication';
}

export interface DispatchOverlayTopologyMessageInput {
    readonly snapshot: CompletedStateSnapshot;
    readonly scope: StateScope;
    readonly sessionId: string;
    readonly webRtcGroupManager: Pick<WebRtcGroupManager, 'notifyOverlayTopologyChanged'>;
}

export interface AdoptOverlayTopologyResult {
    readonly role: GroupLayoutRole;
    readonly outcome: OverlayAdoptionOutcome;
    readonly changed: boolean;
}

export async function dispatchOverlayTopologyMessage(
    input: DispatchOverlayTopologyMessageInput
): Promise<boolean> {
    if (input.snapshot.page.typeId !== AppTopics.overlayTopology) {
        return false;
    }
    const topology = parseAuthoritativeOverlayTopologySnapshot(
        input.snapshot.resource,
        input.scope
    );
    const page = input.snapshot.page;
    const revision = topology.sourceGroupStateCausalRevision;
    if (
        page.scope.kind !== 'group' || page.scope.resourceId !== topology.groupRef.groupId ||
        page.revision !== JSON.stringify([revision.groupRevision, revision.presenceRevision, topology.version])
    ) {
        throw new TypeError('Completed topology differs from its page identity');
    }
    await adoptOverlayTopology({
        topology,
        sessionId: input.sessionId,
        webRtcGroupManager: input.webRtcGroupManager,
        adoption: isRtcTopologyCurrentStateMessage(
                input.snapshot,
                topology,
                input.sessionId
            )
            ? 'current-state'
            : 'publication'
    });
    return true;
}

export async function adoptOverlayTopology(
    input: AdoptOverlayTopologyInput
): Promise<AdoptOverlayTopologyResult> {
    const overlay = toOverlayInfoForSession(input.topology, input.sessionId);
    const groupSnapshot = findGroupStateSnapshotByRef(input.topology.groupRef);
    const acceptedIdentity = groupSnapshot?.group.acceptedLayoutIdentity ?? undefined;
    const role = resolveGroupLayoutRole({
        publication: toGroupLayoutIdentity(input.topology),
        accepted: acceptedIdentity
    });

    const membershipIneligible = groupSnapshot === undefined
        ? wasGroupStateSnapshotObservedByRef(input.topology.groupRef)
        : !isGroupActive(groupSnapshot) || !isSessionInGroup(groupSnapshot, input.sessionId);
    if (membershipIneligible) {
        const outcome = 'membership-ineligible-dropped';
        emitOverlayAdoption(input.topology.overlayId, outcome);
        return { role, outcome, changed: false };
    }

    if (role === 'superseded' || role === 'incomparable') {
        const outcome = role === 'superseded'
            ? 'dominated-dropped'
            : 'incomparable-conflict';
        emitOverlayAdoption(input.topology.overlayId, outcome);
        return { role, outcome, changed: false };
    }

    const result = role === 'planned'
        ? adoptPlannedOverlay(input, overlay)
        : adoptAcceptedOverlay(input, overlay);
    await waitForOverlayRoleChangesIdle(role);
    if (result.changed) {
        await input.webRtcGroupManager.notifyOverlayTopologyChanged();
    }

    return {
        role,
        outcome: result.outcome,
        changed: result.changed
    };
}

function adoptPlannedOverlay(
    input: AdoptOverlayTopologyInput,
    overlay: ReturnType<typeof toOverlayInfoForSession>
): Pick<AdoptOverlayTopologyResult, 'outcome' | 'changed'> {
    const outcome = input.adoption === 'current-state'
        ? overlaysRepository.setCurrentPlannedServerOverlayById(input.topology.overlayId, overlay)
        : overlaysRepository.setPlannedOverlayById(input.topology.overlayId, overlay);
    return {
        outcome,
        changed: overlaysRepository.didOverlayAdoptionChange(outcome)
    };
}

function adoptAcceptedOverlay(
    input: AdoptOverlayTopologyInput,
    overlay: ReturnType<typeof toOverlayInfoForSession>
): Pick<AdoptOverlayTopologyResult, 'outcome' | 'changed'> {
    const outcome = input.adoption === 'current-state'
        ? overlaysRepository.setCurrentAcceptedServerOverlayById(input.topology.overlayId, overlay)
        : overlaysRepository.setAcceptedOverlayById(input.topology.overlayId, overlay);
    const removedPlanned = overlaysRepository.removePlannedOverlayByIdIfIdentity(
        input.topology.overlayId,
        toGroupLayoutIdentity(input.topology)
    );
    return {
        outcome,
        changed: overlaysRepository.didOverlayAdoptionChange(outcome) || removedPlanned
    };
}

async function waitForOverlayRoleChangesIdle(role: 'planned' | 'accepted'): Promise<void> {
    if (role === 'planned') {
        await overlaysRepository.waitForPlannedOverlayChangesIdle();
        return;
    }
    await Promise.all([
        overlaysRepository.waitForPlannedOverlayChangesIdle(),
        overlaysRepository.waitForAcceptedOverlayChangesIdle()
    ]);
}
