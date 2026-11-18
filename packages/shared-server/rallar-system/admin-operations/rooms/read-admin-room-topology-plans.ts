import {
    ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT,
    type AdminRoomReshapeGate,
    type AdminRoomTopologyPlan,
    type AdminRoomTopologyPlansRequest,
    type AdminRoomTopologyPlansResponse
} from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { toCanonicalGroupRef, type GroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarGroupRef } from '@shared/api/rallar-validation.ts';
import type { TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';
import {
    computeBackoffGateIntervalMs,
    computeBackoffGateOpensAt,
    type BackoffGateBounds
} from '@shared/resilience/backoff-gate.ts';

import type { RtcTopologyExecutionRepository } from '../../topology/persistence/rtc-topology-execution-repository.ts';
import type { RtcTopologyPublicationRepository } from '../../topology/publication/rtc-topology-publication-repository.ts';
import type { RtcTopologyPublication } from '../../topology/publication/rtc-topology-publication.ts';

export namespace ReadAdminRoomTopologyPlans {
    export interface Dependencies {
        readonly publications: Pick<
            RtcTopologyPublicationRepository,
            'listGroupPublicationEntriesPage' | 'publicationKey'
        >;
        readonly reshapeGates: Pick<RtcTopologyExecutionRepository, 'readTopologyReshapeGate'>;
        /**
         * The bounds the room's stored lifecycle policy sets on its reshapes: the bounds the planner applies in the one
         * stage the gate applies in, which is the stage that reads the stored policy.
         */
        readonly readReshapeBounds: (roomRef: GroupRef) => Promise<BackoffGateBounds>;
        readonly nowEpochMs: () => number;
    }
}

/** Observes the retained publications and the reshape gate of one room; never plans, repairs or republishes. */
export class ReadAdminRoomTopologyPlans {
    private readonly dependencies: ReadAdminRoomTopologyPlans.Dependencies;

    constructor(dependencies: ReadAdminRoomTopologyPlans.Dependencies) {
        this.dependencies = dependencies;
    }

    async read(request: AdminRoomTopologyPlansRequest): Promise<AdminRoomTopologyPlansResponse> {
        const roomRef = toCanonicalGroupRef(assertValidRallarGroupRef(request.roomRef));
        const { limit, afterPublicationId } = request;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT) {
            throw new RangeError('Topology plans limit is outside the supported range');
        }
        const { publications } = this.dependencies;
        const entries = await publications.listGroupPublicationEntriesPage(roomRef, {
            limit: limit + 1,
            afterKey: afterPublicationId === null ? undefined : publications.publicationKey(roomRef, afterPublicationId)
        });
        const page = entries.slice(0, limit).map((entry) => toAdminRoomTopologyPlan(entry.value));
        return {
            roomRef,
            observedAtEpochMs: this.dependencies.nowEpochMs(),
            plans: page,
            nextAfterPublicationId: entries.length > limit ? page.at(-1)!.publicationId : null,
            reshapeGate: await this.readReshapeGate(roomRef)
        };
    }

    private async readReshapeGate(roomRef: GroupRef): Promise<AdminRoomReshapeGate | null> {
        const stored = await this.dependencies.reshapeGates.readTopologyReshapeGate(roomRef);
        if (stored === null) {
            return null;
        }
        return toAdminRoomReshapeGate(stored.state, await this.dependencies.readReshapeBounds(roomRef));
    }
}

function toAdminRoomReshapeGate(state: TopologyReshapeGateState, bounds: BackoffGateBounds): AdminRoomReshapeGate {
    return {
        gate: state.gate,
        wantedReasons: state.wantedReasons,
        intervalMs: computeBackoffGateIntervalMs(state.gate, bounds),
        opensAtEpochMs: computeBackoffGateOpensAt(state.gate, bounds)
    };
}

function toAdminRoomTopologyPlan(publication: RtcTopologyPublication): AdminRoomTopologyPlan {
    const { snapshot } = publication;
    return {
        publicationId: publication.publicationId,
        requestedAtEpochMs: publication.createdAtEpochMs,
        layout: toGroupLayoutIdentity(snapshot),
        topology: snapshot.topology,
        memberCount: snapshot.activeSessionIds.length,
        degreeLimit: snapshot.degreeLimit,
        plan: publication.plan
    };
}
