import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import type {
    ALOutboundCommitBundle,
    ALOutboundRepairHint
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';

import { room, RtcEndpointFixture } from '../rtc-endpoint-fixture.ts';
import { toOriginDirectedSnapshot } from './rtc-origin-overlay-fixture.ts';

/** A `command` send's receipt: three retries two seconds apart, so every window has passed by then. */
const RECEIPT_LIFETIME_MS = 9_000;

describe('the receipt timeout of a copy an RTC relay forwarded', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('advances the relay row at each deadline without a repair hint, while the origin retries its own', async () => {
        const message = newALMulticastMessage(
            'origin',
            { topicId: 'room.ar-eye-hunter.director', resourceId: 'unanswered-shot', contextId: room.groupId },
            room,
            'room.ar-eye-hunter.director.intent.v1',
            { kind: 'player-shot-intent', senderId: 'origin', seq: 1 },
            { ack: 'group-leader', reliability: 'at-least-once', ttlMs: 30_000, qos: { durability: { algo: 'volatile' } } }
        );
        const origin = createEndpoint('origin', ['relay']);
        const relay = createEndpoint('relay', ['origin', 'director']);
        for (const [endpoint, remote] of [[origin, relay], [relay, origin]] as const) {
            endpoint.observe(1, room, ['origin', 'relay', 'director']);
            endpoint.observeOverlay(1);
            const key = toScopedOverlayId(room);
            endpoint.groups.set(key, toOriginDirectedSnapshot(endpoint.groups.read(key)!, 'director', Date.now()));
            endpoint.connect(remote);
        }
        // The director never answers, so every receipt along the path reaches its deadline.
        vi.spyOn(relay.peers.get('director')!.channel, 'sendJson').mockReturnValue({ status: 'sent', bufferedAmount: 0 });
        const originCommits = recordCommits(origin);
        const relayCommits = recordCommits(relay);

        await origin.multicast.enqueueIfAbsent(message);
        await vi.advanceTimersByTimeAsync(RECEIPT_LIFETIME_MS);

        const retry = { trigger: 'ack-timeout', failedPeerIds: ['director'], missingRanges: [] };
        expect(new Set(readPendingAttempts(relayCommits))).toEqual(new Set([0, 1, 2, 3]));
        expect(readRepairHintRequests(relayCommits)).toEqual([]);
        expect(readRepairHintRequests(originCommits)).toEqual([retry, retry, retry]);
    });
});

function createEndpoint(sessionId: string, peerIds: readonly string[]): RtcEndpointFixture {
    const endpoint = new RtcEndpointFixture(sessionId, peerIds);
    onTestFinished(() => endpoint.close());
    return endpoint;
}

/** The bundles this endpoint's admission store committed, in commit order. */
function recordCommits(endpoint: RtcEndpointFixture): readonly ALOutboundCommitBundle<ALOutboundTransportMessage>[] {
    const committed: ALOutboundCommitBundle<ALOutboundTransportMessage>[] = [];
    const store = endpoint.outbound.admissionStore;
    const commitBundle = store.commitBundle.bind(store);
    vi.spyOn(store, 'commitBundle').mockImplementation(async (bundle) => {
        const status = await commitBundle(bundle);
        if (status === 'committed') {
            committed.push(bundle);
        }
        return status;
    });
    return committed;
}

function readPendingAttempts(commits: readonly ALOutboundCommitBundle<ALOutboundTransportMessage>[]): readonly number[] {
    return commits.flatMap((bundle) => bundle.mutations.flatMap((mutation) => mutation.kind === 'set-pending-ack' ? [mutation.snapshot.attempts] : []));
}

/** Every repair hint this endpoint committed, whatever triggered it. */
function readRepairHintRequests(commits: readonly ALOutboundCommitBundle<ALOutboundTransportMessage>[]): readonly ALOutboundRepairHint[] {
    return commits.flatMap((bundle) => bundle.durableEffects.flatMap((effect) => effect.payload.kind === 'repair-hint' ? [effect.payload.request] : []));
}
