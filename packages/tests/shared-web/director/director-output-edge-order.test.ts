import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserDirectorRelayRuntime } from '@shared-web/browser/director/browser-director-relay-runtime.ts';
import {
    BrowserDirectorRelayTransport,
    RALLAR_DIRECTOR_RELAY_PROTOCOL
} from '@shared-web/browser/director/browser-director-relay-transport.ts';
import { BrowserDirectorStatusRuntime } from '@shared-web/browser/director/browser-director-status-runtime.ts';
import type {
    RallarDirectorRelayEnvelope,
    RallarDirectorRelayHandle
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type { RallarMessageOrderGap } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { RoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createDefaultTestSession } from '../api-middleware-test-double.ts';
import { createDirectorGroupSnapshot } from '../director-group-snapshot-fixture.ts';
import { createEdgeOrderPage, settleTurns, type EdgeOrderPage } from '../messages/edge-order/edge-order-page-fixture.ts';

const TOPIC_ID = 'app.game.director';
const OUTPUT_TYPE_ID = 'game.output';
const DIRECTOR_SESSION_ID = 'director-session';
/** Every page here signs in as the same principal, so the appointment names that principal. */
const PRINCIPAL_ID = createDefaultTestSession().clientId;

interface Output {
    readonly n: number;
}

interface RelayPage {
    readonly page: EdgeOrderPage;
    readonly relay: RallarDirectorRelayHandle<never, Output>;
    /** The outputs this page's application was handed, in order. */
    readonly seen: number[];
    readonly gaps: RallarMessageOrderGap[];
}

function createRelayPage(sessionId: string, snapshot: GroupSnapshot): RelayPage {
    const page = createEdgeOrderPage({ sessionId });
    const session: AuthSession = { ...createDefaultTestSession(), sessionId };
    const seen: number[] = [];
    const gaps: RallarMessageOrderGap[] = [];
    const runtime = new BrowserDirectorRelayRuntime({
        status: createStatusRuntime(session, snapshot),
        transport: new BrowserDirectorRelayTransport({
            messages: page.messages,
            readSession: () => session,
            isWebSocketDown: () => false
        }),
        messages: page.messages,
        readSession: () => session
    });
    const relay = runtime.create<never, Output>({
        roomRef: snapshot.group,
        topicId: TOPIC_ID,
        intentTypeId: 'game.intent',
        outputTypeId: OUTPUT_TYPE_ID,
        heartbeatIntervalMs: 60_000,
        onOutput: (message) => {
            seen.push(message.data.n);
        },
        onOutputGap: (gap) => {
            gaps.push(gap);
        }
    });
    return { page, relay, seen, gaps };
}

/** Who the director is, read from one cached room snapshot whose appointment names the director session. */
function createStatusRuntime(session: AuthSession, snapshot: GroupSnapshot): BrowserDirectorStatusRuntime {
    const scope = { applicationId: snapshot.group.applicationId, workspaceId: snapshot.group.workspaceId };
    const roomStateStore = new RoomStateStore({
        runtime: {
            currentRoomRef: () => undefined,
            setCurrentRoom: () => {},
            clearCurrentRoomIfMatches: () => {},
            readDefaultScope: () => scope,
            resolveOperationScope: () => scope
        },
        readSession: () => session,
        stateCache: {
            onCacheChange: () => () => {},
            readGroupSnapshots: () => [snapshot],
            findGroupSnapshotByRef: () => snapshot,
            wasGroupSnapshotObserved: () => true,
            findFirstGroupRefForSession: () => snapshot.group,
            readClientSnapshots: () => [],
            findClientSnapshot: () => undefined
        }
    });
    return new BrowserDirectorStatusRuntime({
        roomStateStore,
        readWindow: () => ({ earliestEpochMs: Date.now(), latestEpochMs: Date.now() }),
        readSession: () => session,
        resolveDefaultRoom: () => undefined
    });
}

interface DirectorRoom {
    readonly director: RelayPage;
    readonly client: RelayPage;
    readonly snapshot: GroupSnapshot;
}

function createDirectorRoom(): DirectorRoom {
    const snapshot = createDirectorGroupSnapshot({
        sessionId: DIRECTOR_SESSION_ID,
        principalId: PRINCIPAL_ID,
        epoch: 1,
        appointedAtEpochMs: Date.now(),
        heartbeatTtlMs: 60_000
    });
    return {
        director: createRelayPage(DIRECTOR_SESSION_ID, snapshot),
        client: createRelayPage('client-session', snapshot),
        snapshot
    };
}

/** The director's outputs as its RTC carrier took them: a receipted one where `receipted` says so. */
async function sendOutputs(director: RelayPage, outputs: ReadonlyArray<{ n: number; receipted: boolean; }>) {
    for (const output of outputs) {
        const result = await director.relay.sendOutput(
            { n: output.n },
            output.receipted ? { ack: 'all-logical-recipients' } : undefined
        );
        expect(result.status).toBe('sent');
    }
    return director.page.sent.rtc.filter((message) => message.payload.typeId === OUTPUT_TYPE_ID);
}

function toGapSummaries(gaps: readonly RallarMessageOrderGap[]) {
    return gaps.map((gap) => [gap.fromPosition, gap.toPosition, gap.reason]);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the director relay\'s outputs on an edge-ordered channel', () => {
    it('hands a receipted output over before a later unreceipted one that overtook it on the other carrier', async () => {
        const room = createDirectorRoom();
        const [first, second] = await sendOutputs(room.director, [{ n: 1, receipted: true }, { n: 2, receipted: false }]);

        await room.client.page.deliver('rtc', second);
        expect(room.client.seen).toEqual([]);
        await room.client.page.deliver('ws', first);
        await settleTurns();

        expect(room.client.seen).toEqual([1, 2]);
        expect(room.client.gaps).toEqual([]);
    });

    it('does not hand over an output that carries no order stamp', async () => {
        const room = createDirectorRoom();
        await room.director.page.messages.rtc.send<RallarDirectorRelayEnvelope<Output>>({
            roomRef: room.snapshot.group,
            topicId: TOPIC_ID,
            typeId: OUTPUT_TYPE_ID,
            payload: {
                protocol: RALLAR_DIRECTOR_RELAY_PROTOCOL,
                topicId: TOPIC_ID,
                typeId: OUTPUT_TYPE_ID,
                roomId: room.snapshot.group.groupId,
                epoch: 1,
                sentAtEpochMs: Date.now(),
                payload: { n: 1 }
            },
            reliability: 'best-effort',
            ack: 'none',
            ttlMs: 5_000
        });

        await room.client.page.deliver('rtc', room.director.page.sent.rtc[0]);
        await settleTurns();

        expect(room.client.seen).toEqual([]);
    });
});

describe('the director relay\'s output gaps', () => {
    const outputs = [{ n: 1, receipted: true }, { n: 2, receipted: true }, { n: 3, receipted: false }];

    it('hands a later output over after 3 s without the missing one and reports the gap once', async () => {
        const room = createDirectorRoom();
        const [first, , third] = await sendOutputs(room.director, outputs);
        await room.client.page.deliver('ws', first);
        await room.client.page.deliver('rtc', third);

        await vi.advanceTimersByTimeAsync(2_999);
        expect(room.client.seen).toEqual([1]);

        await vi.advanceTimersByTimeAsync(1);
        expect(room.client.seen).toEqual([1, 3]);
        expect(toGapSummaries(room.client.gaps)).toEqual([[2, 2, 'channel-wait-cap']]);
        expect(room.client.gaps[0]).toMatchObject({ senderId: DIRECTOR_SESSION_ID, topicId: TOPIC_ID, typeId: OUTPUT_TYPE_ID });
    });

    it('does not pass on a gap in the stream of a session that is not the appointed director', async () => {
        const room = createDirectorRoom();
        const impostor = createEdgeOrderPage({ sessionId: 'impostor-session' });
        const channel = impostor.messages.room<RallarDirectorRelayEnvelope<Output>>({
            roomRef: room.snapshot.group,
            topicId: TOPIC_ID,
            typeId: OUTPUT_TYPE_ID,
            purpose: 'notification',
            access: 'members',
            order: 'edge'
        });
        await channel.sendRtc(toEnvelope(room.snapshot, 1), { ack: 'all-logical-recipients' });
        await channel.sendRtc(toEnvelope(room.snapshot, 2), { ack: 'all-logical-recipients' });
        await channel.sendRtc(toEnvelope(room.snapshot, 3), { reliability: 'best-effort', ack: 'none' });
        const [first, , third] = impostor.sent.rtc;
        await room.client.page.deliver('rtc', first);
        await room.client.page.deliver('rtc', third);

        await vi.advanceTimersByTimeAsync(3_000);

        expect(room.client.page.messages.readUsage().edgeOrder.gaps).toBe(1);
        expect(room.client.gaps).toEqual([]);
        expect(room.client.seen).toEqual([]);
    });

    it('passes no gap on once the relay is stopped', async () => {
        const room = createDirectorRoom();
        const [first, , third] = await sendOutputs(room.director, outputs);
        await room.client.page.deliver('ws', first);
        await room.client.page.deliver('rtc', third);

        room.client.relay.stop();
        await vi.advanceTimersByTimeAsync(3_000);

        expect(room.client.page.messages.readUsage().edgeOrder.gaps).toBe(1);
        expect(room.client.gaps).toEqual([]);
    });
});

function toEnvelope(snapshot: GroupSnapshot, n: number): RallarDirectorRelayEnvelope<Output> {
    return {
        protocol: RALLAR_DIRECTOR_RELAY_PROTOCOL,
        topicId: TOPIC_ID,
        typeId: OUTPUT_TYPE_ID,
        roomId: snapshot.group.groupId,
        epoch: 1,
        sentAtEpochMs: Date.now(),
        payload: { n }
    };
}
