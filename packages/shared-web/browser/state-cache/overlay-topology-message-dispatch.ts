import { AppTopics } from '@shared/api/api-config.ts';
import { parseAuthoritativeOverlayTopologySnapshot } from '@shared/api/authoritative-state-validation.ts';
import { compareGroupCausalRevision, isGroupActive, isSessionInGroup } from '@shared/api/group-client-views.ts';
import {
    resolveGroupLayoutRole,
    toGroupLayoutIdentity,
    type GroupLayoutRole
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
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

import type { DeferredOverlayTopologies } from './deferred-overlay-topologies.ts';
import { isRtcTopologyCurrentStateMessage } from './is-rtc-topology-current-state-message.ts';

export interface AdoptOverlayTopologyInput {
    readonly topology: RallarOverlayTopologySnapshot;
    readonly sessionId: string;
    readonly webRtcGroupManager: Pick<WebRtcGroupManager, 'notifyOverlayTopologyChanged'>;
    readonly adoption: 'current-state' | 'publication';
    readonly deferredTopologies: DeferredOverlayTopologies;
}

export interface DispatchOverlayTopologyMessageInput {
    readonly snapshot: CompletedStateSnapshot;
    readonly scope: StateScope;
    readonly sessionId: string;
    readonly webRtcGroupManager: Pick<WebRtcGroupManager, 'notifyOverlayTopologyChanged'>;
    readonly deferredTopologies: DeferredOverlayTopologies;
}

export interface AdoptDeferredOverlayTopologyInput {
    readonly groupRef: GroupRef;
    readonly sessionId: string;
    readonly webRtcGroupManager: Pick<WebRtcGroupManager, 'notifyOverlayTopologyChanged'>;
    readonly deferredTopologies: DeferredOverlayTopologies;
}

type OverlayMembershipAdmission = 'admitted' | 'deferred' | 'dropped';

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
        deferredTopologies: input.deferredTopologies,
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
    const admission = resolveOverlayMembershipAdmission(input.topology, input.sessionId);
    if (admission === 'admitted') {
        return await adoptAdmittedOverlayTopology(input);
    }
    const outcome = admission === 'deferred' && input.deferredTopologies.keep(input.topology)
        ? 'membership-ineligible-deferred'
        : 'membership-ineligible-dropped';
    emitOverlayAdoption(input.topology.overlayId, outcome);
    return { role: resolvePublicationRole(input.topology), outcome, changed: false };
}

/**
 * Re-attempts the layout kept for a group once its cached snapshot changes. A
 * kept layout lost its delivery moment, so it is adopted as a publication.
 */
export async function adoptDeferredOverlayTopology(
    input: AdoptDeferredOverlayTopologyInput
): Promise<void> {
    const topology = input.deferredTopologies.find(input.groupRef);
    if (topology === undefined) {
        return;
    }
    const admission = resolveOverlayMembershipAdmission(topology, input.sessionId);
    if (admission === 'deferred') {
        return;
    }
    input.deferredTopologies.discard(input.groupRef);
    if (admission === 'dropped') {
        emitOverlayAdoption(topology.overlayId, 'membership-ineligible-dropped');
        return;
    }
    const result = await adoptAdmittedOverlayTopology({
        topology,
        sessionId: input.sessionId,
        webRtcGroupManager: input.webRtcGroupManager,
        adoption: 'publication',
        deferredTopologies: input.deferredTopologies
    });
    if (result.changed) {
        emitOverlayAdoption(topology.overlayId, 'membership-deferred-adopted');
    }
}

/**
 * A group never observed admits the layout; an observed group admits it only
 * while active with the own session. A layout that places the own session at
 * a revision the cache has not reached is deferred, not dropped.
 */
function resolveOverlayMembershipAdmission(
    topology: RallarOverlayTopologySnapshot,
    sessionId: string
): OverlayMembershipAdmission {
    const groupSnapshot = findGroupStateSnapshotByRef(topology.groupRef);
    if (groupSnapshot === undefined) {
        return wasGroupStateSnapshotObservedByRef(topology.groupRef) ? 'dropped' : 'admitted';
    }
    if (!isGroupActive(groupSnapshot)) {
        return 'dropped';
    }
    if (isSessionInGroup(groupSnapshot, sessionId)) {
        return 'admitted';
    }
    const order = compareGroupCausalRevision(topology.sourceGroupStateCausalRevision, groupSnapshot.causalRevision);
    return topology.activeSessionIds.includes(sessionId) && (order === 'dominates' || order === 'incomparable')
        ? 'deferred'
        : 'dropped';
}

function resolvePublicationRole(topology: RallarOverlayTopologySnapshot): GroupLayoutRole {
    return resolveGroupLayoutRole({
        publication: toGroupLayoutIdentity(topology),
        accepted: findGroupStateSnapshotByRef(topology.groupRef)?.group.acceptedLayoutIdentity ?? undefined
    });
}

async function adoptAdmittedOverlayTopology(
    input: AdoptOverlayTopologyInput
): Promise<AdoptOverlayTopologyResult> {
    input.deferredTopologies.discardThrough(input.topology);
    const overlay = toOverlayInfoForSession(input.topology, input.sessionId);
    const role = resolvePublicationRole(input.topology);
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
    if (result.changed) {
        // Cache writes publish asynchronously. Invalidate RTC ownership before
        // room observers can act on the new target, or a direct room wait can
        // be denied against the previous dial policy.
        await input.webRtcGroupManager.notifyOverlayTopologyChanged();
    }
    await waitForOverlayRoleChangesIdle(role);

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
