import { ReadAdminRoomTopologyPlans } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-topology-plans.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import {
    computeRtcTopologyReshapeGateWrite,
    RTC_TOPOLOGY_RESHAPE_GATES_NAMESPACE
} from '@shared-server/rallar-system/topology/persistence/stored-topology-reshape-gate.ts';
import { RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository.ts';
import { toCanonicalGroupRef, type GroupRef } from '@shared/api/group-types.ts';
import type { TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';
import { expect, it } from 'vitest';

import { BACKOFF_GATE_TEST_BOUNDS } from '../../../../shared/resilience/backoff-gate-test-fixtures.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createGroupRef,
    createPublication,
    createTopologySnapshot
} from '../../topology/rtc-topology-repository-test-fixtures.ts';

const NOW = 5_000;

interface StoreInput {
    readonly ref: GroupRef;
    readonly workId: string;
    readonly version: number;
    readonly state?: 'active' | 'removed';
    readonly live?: boolean;
}

async function createReader() {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const publications = new RtcTopologyPublicationRepository(runtimeRepository);
    const boundsReads: GroupRef[] = [];
    const reader = new ReadAdminRoomTopologyPlans({
        publications,
        reshapeGates: new RtcTopologyExecutionRepository(runtimeRepository),
        readReshapeBounds: (roomRef) => {
            boundsReads.push(roomRef);
            return Promise.resolve(BACKOFF_GATE_TEST_BOUNDS);
        },
        nowEpochMs: () => NOW
    });
    async function storeReshapeGate(ref: GroupRef, state: TopologyReshapeGateState) {
        const write = computeRtcTopologyReshapeGateWrite(ref, state, null);
        await runtimeRepository.upsert({
            namespace: RTC_TOPOLOGY_RESHAPE_GATES_NAMESPACE,
            key: write.key,
            value: write.value,
            expireAtTimestamp: Date.now() + 60_000
        });
    }
    async function store({ ref, workId, version, state = 'active', live = true }: StoreInput) {
        const snapshot = state === 'active'
            ? createTopologySnapshot(ref, version)
            : { ...createTopologySnapshot(ref, version), state, nextHopsBySessionId: { 'session-a': [], 'session-b': [] } };
        const publication = createPublication(snapshot, workId);
        await runtimeRepository.upsert({
            namespace: RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            key: publications.publicationKey(ref, publication.publicationId),
            value: JSON.stringify(publication),
            expireAtTimestamp: live ? Date.now() + 60_000 : Date.now() - 1
        });
        return publication;
    }
    return { reader, store, storeReshapeGate, boundsReads };
}

it('lists only the room\'s own publications, never a room whose id extends it', async () => {
    const { reader, store } = await createReader();
    const roomRef = createGroupRef();
    const own = await store({ ref: roomRef, workId: 'work-own', version: 1 });
    await store({ ref: { ...roomRef, groupId: `${roomRef.groupId}-2` }, workId: 'work-extending', version: 1 });

    const response = await reader.read({ roomRef, limit: 10, afterPublicationId: null });

    expect(response.plans.map((plan) => plan.publicationId)).toEqual([own.publicationId]);
});

it('pages with a cursor and names the next cursor only when more remain', async () => {
    const { reader, store } = await createReader();
    const roomRef = createGroupRef();
    const ids: string[] = [];
    for (const workId of ['work-a', 'work-b', 'work-c']) {
        ids.push((await store({ ref: roomRef, workId, version: 1 })).publicationId);
    }
    ids.sort();

    const first = await reader.read({ roomRef, limit: 2, afterPublicationId: null });
    expect(first.plans.map((plan) => plan.publicationId)).toEqual(ids.slice(0, 2));
    expect(first.nextAfterPublicationId).toBe(ids[1]);

    const second = await reader.read({ roomRef, limit: 2, afterPublicationId: first.nextAfterPublicationId });
    expect(second.plans.map((plan) => plan.publicationId)).toEqual([ids[2]]);
    expect(second.nextAfterPublicationId).toBeNull();
});

it('serves the layout\'s identity, kind, size and record, not its edges', async () => {
    const { reader, store } = await createReader();
    const roomRef = createGroupRef();
    const publication = await store({ ref: roomRef, workId: 'work-one', version: 3 });

    const response = await reader.read({ roomRef, limit: 10, afterPublicationId: null });

    expect(response).toEqual({
        roomRef: toCanonicalGroupRef(roomRef),
        observedAtEpochMs: NOW,
        plans: [{
            publicationId: publication.publicationId,
            requestedAtEpochMs: publication.createdAtEpochMs,
            layout: { groupRevision: 3, presenceRevision: 3, version: 3, state: 'active' },
            topology: 'tree',
            memberCount: 2,
            degreeLimit: 5,
            plan: publication.plan
        }],
        nextAfterPublicationId: null,
        reshapeGate: null
    });
    expect(publication.plan).not.toBeNull();
});

it('serves a removal with a null plan', async () => {
    const { reader, store } = await createReader();
    const roomRef = createGroupRef();
    await store({ ref: roomRef, workId: 'work-removed', version: 4, state: 'removed' });

    const response = await reader.read({ roomRef, limit: 10, afterPublicationId: null });

    expect(response.plans).toHaveLength(1);
    expect(response.plans[0]).toMatchObject({ layout: { version: 4, state: 'removed' }, plan: null });
});

it('a walk that follows the cursor sees every live publication once when expired rows sit between them', async () => {
    const { reader, store } = await createReader();
    const roomRef = createGroupRef();
    const expectedIds: string[] = [];
    for (const [workId, live] of [['work-1', true], ['work-2', false], ['work-3', false], ['work-4', true], ['work-5', true]] as const) {
        const publication = await store({ ref: roomRef, workId, version: 1, state: 'active', live });
        if (live) {
            expectedIds.push(publication.publicationId);
        }
    }

    const first = await reader.read({ roomRef, limit: 2, afterPublicationId: null });
    expect(first.nextAfterPublicationId).not.toBeNull();
    const seen = first.plans.map((plan) => plan.publicationId);
    let cursor = first.nextAfterPublicationId;
    while (cursor !== null) {
        const page = await reader.read({ roomRef, limit: 2, afterPublicationId: cursor });
        seen.push(...page.plans.map((plan) => plan.publicationId));
        cursor = page.nextAfterPublicationId;
    }

    expect(seen).toEqual(expectedIds);
});

it('returns no plans and no cursor for a room whose publications are all expired', async () => {
    const { reader, store } = await createReader();
    const roomRef = createGroupRef();
    await store({ ref: roomRef, workId: 'work-1', version: 1, state: 'active', live: false });
    await store({ ref: roomRef, workId: 'work-2', version: 1, state: 'active', live: false });

    const response = await reader.read({ roomRef, limit: 1, afterPublicationId: null });

    expect(response.plans).toEqual([]);
    expect(response.nextAfterPublicationId).toBeNull();
});

it('ends the walk with a null cursor when only expired rows follow the last live one', async () => {
    const { reader, store } = await createReader();
    const roomRef = createGroupRef();
    const live = await store({ ref: roomRef, workId: 'work-1', version: 1 });
    await store({ ref: roomRef, workId: 'work-2', version: 1, state: 'active', live: false });
    await store({ ref: roomRef, workId: 'work-3', version: 1, state: 'active', live: false });

    const response = await reader.read({ roomRef, limit: 1, afterPublicationId: null });

    expect(response.plans.map((plan) => plan.publicationId)).toEqual([live.publicationId]);
    expect(response.nextAfterPublicationId).toBeNull();
});

it('serves the room\'s stored reshape gate with the wait in force and its opening under the room\'s bounds', async () => {
    const { reader, storeReshapeGate, boundsReads } = await createReader();
    const roomRef = createGroupRef();
    const state: TopologyReshapeGateState = {
        gate: { lastPassAtEpochMs: 1_000, consecutiveHeldPasses: 1, heldAtEpochMs: 2_000 },
        wantedReasons: ['kind-change', 'leader-rooting']
    };
    await storeReshapeGate(roomRef, state);

    const response = await reader.read({ roomRef, limit: 10, afterPublicationId: null });

    expect(response.reshapeGate).toEqual({ ...state, intervalMs: 30_000, opensAtEpochMs: 31_000 });
    expect(boundsReads).toEqual([toCanonicalGroupRef(roomRef)]);
});

it('serves a stored gate before the room\'s first reshape with no opening', async () => {
    const { reader, storeReshapeGate } = await createReader();
    const roomRef = createGroupRef();
    const state: TopologyReshapeGateState = {
        gate: { lastPassAtEpochMs: null, consecutiveHeldPasses: 0, heldAtEpochMs: null },
        wantedReasons: []
    };
    await storeReshapeGate(roomRef, state);

    const response = await reader.read({ roomRef, limit: 10, afterPublicationId: null });

    expect(response.reshapeGate).toEqual({ ...state, intervalMs: 15_000, opensAtEpochMs: null });
});

it('serves no reshape gate, and reads no bounds, for a room that stores none', async () => {
    const { reader, storeReshapeGate, boundsReads } = await createReader();
    const roomRef = createGroupRef();
    await storeReshapeGate({ ...roomRef, groupId: `${roomRef.groupId}-2` }, {
        gate: { lastPassAtEpochMs: 1_000, consecutiveHeldPasses: 0, heldAtEpochMs: null },
        wantedReasons: []
    });

    const response = await reader.read({ roomRef, limit: 10, afterPublicationId: null });

    expect(response.reshapeGate).toBeNull();
    expect(boundsReads).toEqual([]);
});
