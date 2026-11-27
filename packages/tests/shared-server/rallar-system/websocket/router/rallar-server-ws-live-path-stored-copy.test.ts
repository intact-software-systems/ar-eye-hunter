import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '@shared/alm/ALStoreRetention.ts';

import { roomMessage } from '../../../../shared/services/ws-queue-box-server-receipt-fixture.ts';
import {
    advanceLiveRoomClock,
    connectLiveRoomSession,
    createLiveRoomClusterFixture,
    readLiveRoomStoredCopies,
    settleLiveRoomCluster,
    type LiveRoomClusterFixture
} from './live-room-cluster-fixture.ts';

const ORIGIN = 'p';
const ROOM = [ORIGIN, 'r1', 'r2'];
const LIFETIME_MS = 10_000;
const KEEPS_ALL = () => false;

describe('the server\'s inbound store keeps a live-path room send for its repair', () => {
    // Pins a change to the inbound store's retention that leaves a live-path send with no envelope or audience another
    // instance can read before its deadline: the resend of ruling M1 would then send nothing.
    it('keeps a handed-on send\'s envelope and admitted audience readable by another instance until its deadline', async () => {
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: ROOM, volatileInbound: false });
        const { a, b } = fixture.instances;
        await connectLiveRoomSession(a, ORIGIN, KEEPS_ALL);
        await connectLiveRoomSession(a, 'r1', KEEPS_ALL);
        await connectLiveRoomSession(b, 'r2', KEEPS_ALL);
        const deadlineMs = fixture.clock.nowMs + LIFETIME_MS;
        const sends = [
            receipted(fixture, 'm-1'),
            { ...receipted(fixture, 'm-2'), delivery: { reliability: 'at-least-once', ack: 'none' } } satisfies ALMessage
        ];
        await handOn(fixture, sends);
        const store = b.stores.inboundStores.admissionStore;

        expect(await readLiveRoomStoredCopies(store, sends, fixture.clock.nowMs)).toEqual(
            sends.map((envelope) => ({ envelope, sourceAudience: ROOM, ingressAudience: ROOM }))
        );
        fixture.clock.nowMs = deadlineMs - 1;
        expect(await readLiveRoomStoredCopies(store, sends, fixture.clock.nowMs)).toEqual(
            sends.map((envelope) => ({ envelope, sourceAudience: ROOM, ingressAudience: ROOM }))
        );
        fixture.clock.nowMs = deadlineMs;
        expect((await readLiveRoomStoredCopies(store, sends, fixture.clock.nowMs)).map(({ envelope }) => envelope)).toEqual([undefined, undefined]);
    });

    // Turned by slice 4 (ruling M1; design section 6, "One instance"): the memory pair of a server of one process will
    // keep a receipted envelope to its deadline. Pins today's release of it at the pair's next sweep.
    it('releases a handed-on send\'s envelope from a memory pair at its next sweep, before its deadline', async () => {
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: ROOM, volatileInbound: true });
        const { a } = fixture.instances;
        await connectLiveRoomSession(a, ORIGIN, KEEPS_ALL);
        await connectLiveRoomSession(a, 'r1', KEEPS_ALL);
        const send = roomMessage({ msgId: 'm-1', originPeerId: ORIGIN, nowMs: fixture.clock.nowMs, lifetimeMs: 2 * AL_VOLATILE_STORE_EVICTION_INTERVAL_MS });
        await handOn(fixture, [send]);
        const store = a.stores.volatileStores!.admissionStore;
        expect(await readLiveRoomStoredCopies(store, [send], fixture.clock.nowMs)).toEqual([{ envelope: send, sourceAudience: ROOM, ingressAudience: ROOM }]);

        await advanceLiveRoomClock(fixture, AL_VOLATILE_STORE_EVICTION_INTERVAL_MS);

        expect(fixture.clock.nowMs).toBeLessThan(send.constraints!.expiresAtMs!);
        expect((await readLiveRoomStoredCopies(store, [send], fixture.clock.nowMs))[0]!.envelope).toBeUndefined();
    });
});

function receipted(fixture: LiveRoomClusterFixture, msgId: string): ALMessage {
    return roomMessage({ msgId, originPeerId: ORIGIN, nowMs: fixture.clock.nowMs, lifetimeMs: LIFETIME_MS });
}

/** Offers each send from the origin on instance a and settles the cluster, so each is handed to the router once. */
async function handOn(fixture: LiveRoomClusterFixture, sends: readonly ALMessage[]): Promise<void> {
    for (const message of sends) {
        expect((await fixture.instances.a.service.acceptIncomingMessage(message, ORIGIN)).right).toEqual({ kind: 'admitted' });
        await settleLiveRoomCluster(fixture);
    }
    const { a, b } = fixture.instances;
    expect([...a.handledMsgIds, ...b.handledMsgIds]).toEqual(sends.map((message) => message.id.msgId));
}
