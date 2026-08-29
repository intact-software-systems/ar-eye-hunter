import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { parseAuthoritativeOverlayTopologySnapshot } from '@shared/api/authoritative-state-validation.ts';
import { isGroupActive, isSessionInGroup } from '@shared/api/group-client-views.ts';
import {
    resolveGroupLayoutRole,
    toGroupLayoutIdentity,
    type GroupLayoutRole
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { toOverlayInfoForSession, type RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { findGroupStateSnapshotByRef } from '@shared/repository/group-state-snapshots-repository.ts';
import { emitOverlayAdoption, type OverlayAdoptionOutcome } from '@shared/repository/overlay-adoption-diagnostics.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import type { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';

import { isRtcTopologyCurrentStateMessage } from './is-rtc-topology-current-state-message.ts';

export interface AdoptOverlayTopologyInput {
    readonly topology: RallarOverlayTopologySnapshot;
    readonly sessionId: string;
    readonly webRtcGroupManager: WebRtcGroupManager;
    readonly adoption: 'current-state' | 'publication';
}

export interface DispatchOverlayTopologyMessageInput {
    readonly message: ALMessage;
    readonly scope: StateScope;
    readonly sessionId: string;
    readonly webRtcGroupManager: WebRtcGroupManager;
}

export interface AdoptOverlayTopologyResult {
    readonly role: GroupLayoutRole;
    readonly outcome: OverlayAdoptionOutcome;
    readonly changed: boolean;
}

export async function dispatchOverlayTopologyMessage(
    input: DispatchOverlayTopologyMessageInput
): Promise<boolean> {
    if (input.message.payload.typeId !== AppTopics.overlayTopology) {
        return false;
    }
    const topology = parseAuthoritativeOverlayTopologySnapshot(
        input.message.payload.resource,
        input.scope
    );
    await adoptOverlayTopology({
        topology,
        sessionId: input.sessionId,
        webRtcGroupManager: input.webRtcGroupManager,
        adoption: isRtcTopologyCurrentStateMessage(
                input.message,
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

    if (
        groupSnapshot !== undefined &&
        (!isGroupActive(groupSnapshot) || !isSessionInGroup(groupSnapshot, input.sessionId))
    ) {
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
