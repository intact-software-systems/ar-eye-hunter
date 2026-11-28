// Ruling M1 and slice 4 cited below are the maintainer's ruling on R16 of plans/active/alm-v1-production-readiness.md
// (a room copy missed on the default fan-out) and that item's repair on a server of one process, numbered within R16
// and not the plan's own slices.
import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '@shared/alm/ALStoreRetention.ts';

import {
    connectLiveRoomSession,
    createLiveRoomClusterFixture,
    createLiveRoomSend,
    LIVE_ROOM_ORIGIN,
    LIVE_ROOM_SESSION_IDS,
    readLiveRoomStoredCopies,
    settleLiveRoomCluster,
    type LiveRoomClusterFixture
} from './live-room-cluster-fixture.ts';

const LIFETIME_MS = 10_000;

describe('the server\'s inbound store keeps a live-path room send for its repair', () => {
    // Pins a change to the inbound store's retention that leaves a live-path send with no envelope or audience another
    // instance can read before its deadline: the resend of ruling M1 would then send nothing.
    it('keeps a handed-on send\'s envelope and admitted audience readable by another instance until its deadline', async () => {
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: LIVE_ROOM_SESSION_IDS, volatileInbound: false });
        const { a, b } = fixture.instances;
        await connectLiveRoomSession(a, LIVE_ROOM_ORIGIN, undefined);
        await connectLiveRoomSession(a, 'r1', undefined);
        await connectLiveRoomSession(b, 'r2', undefined);
        const sentAtMs = fixture.clock.nowMs;
        const receipted = createLiveRoomSend({ msgId: 'm-1', nowMs: sentAtMs, lifetimeMs: LIFETIME_MS });
        const unreceipted: ALMessage = {
            ...createLiveRoomSend({ msgId: 'm-2', nowMs: sentAtMs, lifetimeMs: LIFETIME_MS }),
            delivery: { reliability: 'at-least-once', ack: 'none' }
        };
        const sends = [receipted, unreceipted];
        await handOn(fixture, sends);
        const store = b.stores.inboundStores.admissionStore;
        const kept = sends.map((envelope) => ({ envelope, sourceAudience: LIVE_ROOM_SESSION_IDS, ingressAudience: LIVE_ROOM_SESSION_IDS }));

        expect(await readLiveRoomStoredCopies(store, sends, fixture.clock.nowMs)).toEqual(kept);
        fixture.clock.nowMs = sentAtMs + LIFETIME_MS - 1;
        expect(await readLiveRoomStoredCopies(store, sends, fixture.clock.nowMs)).toEqual(kept);
        fixture.clock.nowMs = sentAtMs + LIFETIME_MS;
        expect((await readLiveRoomStoredCopies(store, sends, fixture.clock.nowMs)).map(({ envelope }) => envelope)).toEqual([undefined, undefined]);
    });

    // Turned by slice 4 (ruling M1, a server of one process): the memory pair will keep a receipted envelope to its
    // deadline. Pins today's release of it at the pair's next sweep, one interval after the first.
    it('releases a handed-on send\'s envelope from a memory pair at its next sweep, before its deadline', async () => {
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: LIVE_ROOM_SESSION_IDS, volatileInbound: true });
        const { a } = fixture.instances;
        await connectLiveRoomSession(a, LIVE_ROOM_ORIGIN, undefined);
        await connectLiveRoomSession(a, 'r1', undefined);
        const send = createLiveRoomSend({ msgId: 'm-1', nowMs: fixture.clock.nowMs, lifetimeMs: 2 * AL_VOLATILE_STORE_EVICTION_INTERVAL_MS });
        await handOn(fixture, [send]);
        const store = a.stores.volatileStores!.admissionStore;
        expect(await readLiveRoomStoredCopies(store, [send], fixture.clock.nowMs)).toEqual([
            { envelope: send, sourceAudience: LIVE_ROOM_SESSION_IDS, ingressAudience: LIVE_ROOM_SESSION_IDS }
        ]);

        fixture.clock.nowMs += AL_VOLATILE_STORE_EVICTION_INTERVAL_MS;
        await settleLiveRoomCluster(fixture);

        expect(fixture.clock.nowMs).toBeLessThan(send.constraints!.expiresAtMs!);
        expect((await readLiveRoomStoredCopies(store, [send], fixture.clock.nowMs))[0]!.envelope).toBeUndefined();
    });
});

/** Offers each send from the origin on instance a and settles the cluster, so each is handed to the router once. */
async function handOn(fixture: LiveRoomClusterFixture, sends: readonly ALMessage[]): Promise<void> {
    for (const message of sends) {
        expect((await fixture.instances.a.service.acceptIncomingMessage(message, LIVE_ROOM_ORIGIN)).right).toEqual({ kind: 'admitted' });
        await settleLiveRoomCluster(fixture);
    }
    const { a, b } = fixture.instances;
    expect([...a.handledMsgIds, ...b.handledMsgIds]).toEqual(sends.map((message) => message.id.msgId));
}
