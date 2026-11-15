import {
    ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT,
    type AdminRoomTopologyPlan,
    type AdminRoomTopologyPlansRequest,
    type AdminRoomTopologyPlansResponse
} from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { toCanonicalGroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarGroupRef } from '@shared/api/rallar-validation.ts';

import type { RtcTopologyPublicationRepository } from '../../topology/publication/rtc-topology-publication-repository.ts';
import type { RtcTopologyPublication } from '../../topology/publication/rtc-topology-publication.ts';

export namespace ReadAdminRoomTopologyPlans {
    export interface Dependencies {
        readonly publications: Pick<
            RtcTopologyPublicationRepository,
            'listGroupPublicationEntriesPage' | 'publicationKey'
        >;
        readonly nowEpochMs: () => number;
    }
}

/** Observes the retained publications of one room; never plans, repairs or republishes. */
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
            nextAfterPublicationId: entries.length > limit ? page.at(-1)?.publicationId ?? null : null
        };
    }
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
