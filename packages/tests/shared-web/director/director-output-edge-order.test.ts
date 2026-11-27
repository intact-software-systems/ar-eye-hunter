import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserDirectorOutputChannels } from '@shared-web/browser/director/browser-director-output-channels.ts';
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
import {
    createEdgeOrderPage,
    readEdgeOrderDrops,
    settleTurns,
    type EdgeOrderPage
} from '../messages/edge-order/edge-order-page-fixture.ts';

const TOPIC_ID = 'app.game.director';
const OUTPUT_TYPE_ID = 'game.output';
const DIRECTOR_SESSION_ID = 'director-session';
/** Every page here signs in as the same principal, so the appointment names that principal. */
const PRINCIPAL_ID = createDefaultTestSession().clientId;

interface Output {
    readonly n: number;
}

/** One relay's handle and what its application was handed, in order. */
interface RelayRecord {
    readonly relay: RallarDirectorRelayHandle<never, Output>;
    readonly seen: number[];
    readonly gaps: RallarMessageOrderGap[];
}

interface RelayPage extends RelayRecord {
    readonly page: EdgeOrderPage;
}

interface PageRuntime {
    readonly page: EdgeOrderPage;
    readonly runtime: BrowserDirectorRelayRuntime;
}

/** One page's relay runtime, whose status reads the directors the given room snapshots appoint. */
function createPageRuntime(sessionId: string, snapshots: readonly GroupSnapshot[]): PageRuntime {
    const page = createEdgeOrderPage({ sessionId });
    const session: AuthSession = { ...createDefaultTestSession(), sessionId };
    const runtime = new BrowserDirectorRelayRuntime({
        status: createStatusRuntime(session, snapshots),
        transport: new BrowserDirectorRelayTransport({
            messages: page.messages,
            readSession: () => session,
            isWebSocketDown: () => false
        }),
        messages: page.messages,
        readSession: () => session
    });
    return { page, runtime };
}

function openRelay(runtime: BrowserDirectorRelayRuntime, snapshot: GroupSnapshot): RelayRecord {
    const seen: number[] = [];
    const gaps: RallarMessageOrderGap[] = [];
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
    return { relay, seen, gaps };
}

function createRelayPage(sessionId: string, snapshot: GroupSnapshot): RelayPage {
    const { page, runtime } = createPageRuntime(sessionId, [snapshot]);
    return { page, ...openRelay(runtime, snapshot) };
}

/** Who the director is in each room, read from cached room snapshots whose appointments name the director sessions. */
function createStatusRuntime(session: AuthSession, snapshots: readonly GroupSnapshot[]): BrowserDirectorStatusRuntime {
    const { applicationId, workspaceId } = snapshots[0].group;
    const scope = { applicationId, workspaceId };
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
            readGroupSnapshots: () => snapshots,
            findGroupSnapshotByRef: (roomRef) => snapshots.find((snapshot) => snapshot.group.groupId === roomRef.groupId),
            wasGroupSnapshotObserved: () => true,
            findFirstGroupRefForSession: () => snapshots[0].group,
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

/** A room whose appointment names the director session. */
function createRoomSnapshot(groupId: string, directorSessionId: string): GroupSnapshot {
    const snapshot = createDirectorGroupSnapshot({
        sessionId: directorSessionId,
        principalId: PRINCIPAL_ID,
        epoch: 1,
        appointedAtEpochMs: Date.now(),
        heartbeatTtlMs: 60_000
    });
    return { ...snapshot, group: { ...snapshot.group, groupId } };
}

interface DirectorRoom {
    readonly director: RelayPage;
    readonly client: RelayPage;
    readonly snapshot: GroupSnapshot;
}

function createDirectorRoom(): DirectorRoom {
    const snapshot = createRoomSnapshot('room-1', DIRECTOR_SESSION_ID);
    return {
        director: createRelayPage(DIRECTOR_SESSION_ID, snapshot),
        client: createRelayPage('client-session', snapshot),
        snapshot
    };
}

/** One client page that follows two rooms with the same topic and output type, each with its own director. */
interface TwoRoomPage {
    readonly firstDirector: RelayPage;
    readonly secondDirector: RelayPage;
    /** The client's relay of the first room, created before the second's. */
    readonly first: RelayRecord;
    readonly second: RelayRecord;
    readonly client: EdgeOrderPage;
}

function createTwoRoomPage(): TwoRoomPage {
    const firstRoom = createRoomSnapshot('room-1', 'first-director-session');
    const secondRoom = createRoomSnapshot('room-2', 'second-director-session');
    const client = createPageRuntime('client-session', [firstRoom, secondRoom]);
    return {
        firstDirector: createRelayPage('first-director-session', firstRoom),
        secondDirector: createRelayPage('second-director-session', secondRoom),
        first: openRelay(client.runtime, firstRoom),
        second: openRelay(client.runtime, secondRoom),
        client: client.page
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

    it('holds an unreceipted output that overtook a receipted one mid-stream until the receipted one arrives', async () => {
        const room = createDirectorRoom();
        const [first, second, third] = await sendOutputs(room.director, [
            { n: 1, receipted: true },
            { n: 2, receipted: true },
            { n: 3, receipted: false }
        ]);
        await room.client.page.deliver('ws', first);

        await room.client.page.deliver('rtc', third);
        expect(room.client.seen).toEqual([1]);
        await room.client.page.deliver('ws', second);
        await settleTurns();

        expect(room.client.seen).toEqual([1, 2, 3]);
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

        const [unstamped] = room.director.page.sent.rtc;
        await room.client.page.deliver('rtc', unstamped);
        await settleTurns();

        expect(room.client.seen).toEqual([]);
        expect(readEdgeOrderDrops(room.client.page)).toEqual([
            expect.objectContaining({ kind: 'edge-order-arrival', outcome: 'unwrapped', msgId: unstamped.id.msgId })
        ]);
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
        const channel = new BrowserDirectorOutputChannels({ messages: impostor.messages })
            .open<Output>({ topicId: TOPIC_ID, typeId: OUTPUT_TYPE_ID });
        const roomRef = room.snapshot.group;
        await channel.sendRtc(toEnvelope(room.snapshot, 1), { roomRef, ack: 'all-logical-recipients' });
        await channel.sendRtc(toEnvelope(room.snapshot, 2), { roomRef, ack: 'all-logical-recipients' });
        await channel.sendRtc(toEnvelope(room.snapshot, 3), { roomRef, reliability: 'best-effort', ack: 'none' });
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

describe('the director relay\'s output gaps with two relays of one topic on a page', () => {
    const outputs = [{ n: 1, receipted: true }, { n: 2, receipted: true }, { n: 3, receipted: false }];

    /** The director's outputs 1 and 3 reach the client page; 2 never does. */
    async function deliverAroundAGap(director: RelayPage, client: EdgeOrderPage): Promise<void> {
        const [first, , third] = await sendOutputs(director, outputs);
        await client.deliver('ws', first);
        await client.deliver('rtc', third);
    }

    it('passes each director\'s gap to the relay of that director\'s room only', async () => {
        const pages = createTwoRoomPage();
        await deliverAroundAGap(pages.firstDirector, pages.client);
        await deliverAroundAGap(pages.secondDirector, pages.client);

        await vi.advanceTimersByTimeAsync(3_000);

        expect(pages.first.seen).toEqual([1, 3]);
        expect(pages.second.seen).toEqual([1, 3]);
        expect(pages.first.gaps.map((gap) => gap.senderId)).toEqual(['first-director-session']);
        expect(pages.second.gaps.map((gap) => gap.senderId)).toEqual(['second-director-session']);
    });

    it('still passes the first relay\'s gaps on after the later-created relay stopped', async () => {
        const pages = createTwoRoomPage();
        pages.second.relay.stop();
        await deliverAroundAGap(pages.firstDirector, pages.client);

        await vi.advanceTimersByTimeAsync(3_000);

        expect(toGapSummaries(pages.first.gaps)).toEqual([[2, 2, 'channel-wait-cap']]);
        expect(pages.second.gaps).toEqual([]);
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
