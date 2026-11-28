import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import type { RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import { createRallarGameMatch, type RallarGameMatchHandle, type RallarGameRallarFacade } from '@shared-web/game/mod.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { RALLAR_GAME_SNAPSHOT_REQUEST_TYPE_ID } from '@shared/rallar-game/snapshot-request.ts';

import { createDefaultTestSession } from './api-middleware-test-double.ts';
import { toDirectorAppointment } from './director-group-snapshot-fixture.ts';
import { createDirectorRelayPage, type DirectorRelayPage } from './director/director-relay-page-fixture.ts';
import { settleTurns } from './messages/edge-order/edge-order-page-fixture.ts';
import { createGameRoomStateFixture } from './rallar-game-room-state-fixture.ts';

const ROOM_REF: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const TOPIC_ID = 'app.game';
const EVENT_TYPE_ID = `${TOPIC_ID}.event.v1`;
const DIRECTOR_SESSION_ID = 'director-session';
const CLIENT_SESSION_ID = 'client-session';
/** Both pages sign in as the same principal, so the appointment names that principal. */
const PRINCIPAL_ID = createDefaultTestSession().clientId;

interface GameEvent {
    readonly n: number;
}

type GameMatch = RallarGameMatchHandle<never, never, never, GameEvent>;

/** The room both pages are active in, as its members' room state, and the same room appointing the director. */
interface DirectedRoom {
    readonly roomState: RallarRoomState;
    readonly snapshot: GroupSnapshot;
}

function createDirectedRoom(): DirectedRoom {
    const roomState = createGameRoomStateFixture(ROOM_REF, [{
        principalId: PRINCIPAL_ID,
        username: 'player',
        role: 'member',
        status: 'active',
        isOwner: false,
        isOnline: true,
        sessionIds: [DIRECTOR_SESSION_ID, CLIENT_SESSION_ID],
        topicGrants: {}
    }]);
    const room = roomState.currentRoom;
    if (!room) {
        throw new Error('The room state fixture carries the current room.');
    }
    const appointment = toDirectorAppointment({
        sessionId: DIRECTOR_SESSION_ID,
        principalId: PRINCIPAL_ID,
        epoch: 1,
        appointedAtEpochMs: Date.now(),
        heartbeatTtlMs: 60_000
    });
    return { roomState, snapshot: { ...room, group: { ...room.group, metadata: { rallarDirector: appointment } } } };
}

/** The match's view of one page: the page's real director status and relay, and the room state this test fixes. */
function createMatchFacade(page: DirectorRelayPage, roomState: RallarRoomState): RallarGameRallarFacade {
    const base = createRallarFacade();
    const subscribeNone = () => () => {};
    return {
        session: () => page.session,
        subscriptions: base.subscriptions,
        rooms: {
            ...base.rooms,
            state: () => roomState,
            onChange: subscribeNone,
            waitForPresence: () => Promise.reject(new Error('No page in this test waits for presence.'))
        },
        people: { ...base.people, onChange: subscribeNone },
        director: {
            ...base.director,
            status: (room, options) => page.status.read(room, options),
            onStatus: (listener) => page.status.onStatus(listener),
            createRelay: (config) => page.runtime.create(config)
        },
        rtc: { ...base.rtc, onStatus: subscribeNone },
        realtime: { ...base.realtime, onJson: subscribeNone },
        messages: { ...base.messages, ws: { ...base.messages.ws, onMessage: subscribeNone } },
        ws: base.ws
    };
}

/** The matches a test started, stopped after it. */
const matches: GameMatch[] = [];

async function startMatch(page: DirectorRelayPage, roomState: RallarRoomState, seen: number[]): Promise<GameMatch> {
    const match = createRallarGameMatch<never, never, never, GameEvent>({
        rallar: createMatchFacade(page, roomState),
        protocol: 'test.game.v1',
        topicId: TOPIC_ID,
        roomRef: ROOM_REF,
        heartbeatTtlMs: 60_000,
        onEvent: (envelope) => {
            seen.push(envelope.payload.n);
        }
    });
    matches.push(match);
    await match.start();
    return match;
}

/** A director page and a client page in one room, each running a match; the client's records its events. */
interface MatchPages {
    readonly directorPage: DirectorRelayPage;
    readonly clientPage: DirectorRelayPage;
    readonly director: GameMatch;
    readonly seen: number[];
}

async function startMatchPages(): Promise<MatchPages> {
    const room = createDirectedRoom();
    const directorPage = createDirectorRelayPage(DIRECTOR_SESSION_ID, [room.snapshot]);
    const clientPage = createDirectorRelayPage(CLIENT_SESSION_ID, [room.snapshot]);
    const seen: number[] = [];
    const director = await startMatch(directorPage, room.roomState, []);
    await startMatch(clientPage, room.roomState, seen);
    return { directorPage, clientPage, director, seen };
}

/** The director's events as its RTC carrier took them. */
function readSentEvents(directorPage: DirectorRelayPage) {
    return directorPage.page.sent.rtc.filter((message) => message.payload.typeId === EVENT_TYPE_ID);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    for (const match of matches.splice(0)) {
        match.stop();
    }
    vi.useRealTimers();
});

describe('a Rallar Game match\'s events across carriers', () => {
    it('hands a receipted event over before the unreceipted next one that overtook it', async () => {
        const { directorPage, clientPage, director, seen } = await startMatchPages();

        expect((await director.publishEvent({ n: 1 }, { ack: 'all-logical-recipients' })).status).toBe('sent');
        expect((await director.publishEvent({ n: 2 })).status).toBe('sent');
        const [first, second] = readSentEvents(directorPage);
        await clientPage.page.deliver('rtc', second);
        expect(seen).toEqual([]);
        await clientPage.page.deliver('ws', first);
        await settleTurns();

        expect(seen).toEqual([1, 2]);
    });

    it('hands the event after a gap over when the wait ends, while the sync request the gap started is unconfirmed', async () => {
        const { directorPage, clientPage, director, seen } = await startMatchPages();
        await director.publishEvent({ n: 1 }, { ack: 'all-logical-recipients' });
        await director.publishEvent({ n: 2 }, { ack: 'all-logical-recipients' });
        await director.publishEvent({ n: 3 });
        const [first, , third] = readSentEvents(directorPage);
        await clientPage.page.deliver('ws', first);
        await clientPage.page.deliver('rtc', third);

        await vi.advanceTimersByTimeAsync(3_000);

        expect(seen).toEqual([1, 3]);
        expect(clientPage.page.sent.rtc.map((message) => message.payload.typeId)).toEqual([RALLAR_GAME_SNAPSHOT_REQUEST_TYPE_ID]);
        expect(clientPage.page.messages.readUsage().edgeOrder.gaps).toBe(1);
    });
});
