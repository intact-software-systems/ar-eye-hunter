import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    RallarDirectorRelayEnvelope,
    RallarDirectorRelayHandle
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createDefaultTestSession } from '../api-middleware-test-double.ts';
import { createDirectorGroupSnapshot } from '../director-group-snapshot-fixture.ts';
import { settleTurns, type EdgeOrderPage } from '../messages/edge-order/edge-order-page-fixture.ts';
import { createDirectorRelayPage, type DirectorRelayPage } from './director-relay-page-fixture.ts';

const TOPIC_ID = 'app.game.director';
const SYNC_REQUEST_TYPE_ID = 'game.sync-request';
const SNAPSHOT_TYPE_ID = 'game.snapshot';
const DIRECTOR_SESSION_ID = 'director-session';
/** Every page here signs in as the same principal, so the appointment names that principal. */
const PRINCIPAL_ID = createDefaultTestSession().clientId;

interface Snapshot {
    readonly revision: number;
}

/**
 * What the director's application holds and was asked: the snapshot it answers with, how often the relay read it, and
 * the requests it saw.
 */
interface DirectorApplication {
    snapshot: Snapshot;
    snapshotReads: number;
    readonly syncRequests: RallarMessagePayload[];
}

interface DirectorRelay {
    readonly page: EdgeOrderPage;
    readonly relay: RallarDirectorRelayHandle<never, never, Snapshot>;
    readonly application: DirectorApplication;
}

interface SyncRoom {
    readonly director: DirectorRelay;
    readonly client: RallarDirectorRelayHandle<never, never, Snapshot>;
    readonly clientPage: EdgeOrderPage;
    /** The room snapshots the director's page reads its appointment from; a test may replace the room's. */
    readonly directorSnapshots: GroupSnapshot[];
}

/** A room whose appointment names the given director session. */
function createRoomSnapshot(directorSessionId: string, epoch: number): GroupSnapshot {
    return createDirectorGroupSnapshot({
        sessionId: directorSessionId,
        principalId: PRINCIPAL_ID,
        epoch,
        appointedAtEpochMs: Date.now(),
        heartbeatTtlMs: 60_000
    });
}

function createDirectorRelay(page: DirectorRelayPage, snapshot: GroupSnapshot, readsSnapshot: boolean): DirectorRelay {
    const application: DirectorApplication = { snapshot: { revision: 1 }, snapshotReads: 0, syncRequests: [] };
    const readSnapshot = () => {
        application.snapshotReads += 1;
        return application.snapshot;
    };
    const relay = page.runtime.create<never, never, Snapshot>({
        roomRef: snapshot.group,
        topicId: TOPIC_ID,
        intentTypeId: 'game.intent',
        outputTypeId: 'game.output',
        snapshotTypeId: SNAPSHOT_TYPE_ID,
        syncRequestTypeId: SYNC_REQUEST_TYPE_ID,
        heartbeatIntervalMs: 60_000,
        snapshotIntervalMs: false,
        readSnapshot: readsSnapshot ? readSnapshot : undefined,
        onSyncRequest: (message) => {
            application.syncRequests.push(message.data);
        }
    });
    return { page: page.page, relay, application };
}

function createSyncRoom(readsSnapshot = true): SyncRoom {
    const snapshot = createRoomSnapshot(DIRECTOR_SESSION_ID, 1);
    const directorSnapshots = [snapshot];
    const directorPage = createDirectorRelayPage(DIRECTOR_SESSION_ID, directorSnapshots);
    const client = createDirectorRelayPage('client-session', [snapshot]);
    return {
        director: createDirectorRelay(directorPage, snapshot, readsSnapshot),
        client: client.runtime.create<never, never, Snapshot>({
            roomRef: snapshot.group,
            topicId: TOPIC_ID,
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            snapshotTypeId: SNAPSHOT_TYPE_ID,
            syncRequestTypeId: SYNC_REQUEST_TYPE_ID,
            heartbeatIntervalMs: 60_000
        }),
        clientPage: client.page,
        directorSnapshots
    };
}

/** The client asks for a sync, the room's leader confirms it, and the request reaches the director's page. */
async function deliverSyncRequest(room: SyncRoom, reason: string): Promise<void> {
    const requesting = room.client.requestSync({ reason });
    await settleTurns();
    const request = room.clientPage.sent.rtc.filter(isSyncRequest).at(-1);
    if (!request) {
        throw new Error('The client sent no sync request.');
    }
    room.clientPage.acknowledge('rtc', request);
    expect((await requesting).status).toBe('sent');
    await room.director.page.deliver('rtc', request);
}

function isSyncRequest(message: ALMessage): boolean {
    return message.payload.typeId === SYNC_REQUEST_TYPE_ID;
}

/** The snapshots the director's page put on either carrier. */
function readSentSnapshots(page: EdgeOrderPage): Snapshot[] {
    return [...page.sent.rtc, ...page.sent.ws]
        .filter((message) => message.payload.typeId === SNAPSHOT_TYPE_ID)
        .map((message) => toSnapshot(JSON.parse(message.payload.resource)));
}

/** A sent snapshot's resource is the relay envelope this page's own relay stamped. */
function toSnapshot(envelope: RallarDirectorRelayEnvelope<Snapshot>): Snapshot {
    return envelope.payload;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the director\'s answer to a burst of sync requests', () => {
    it('answers three sync requests inside 250 ms with one snapshot, 250 ms after the first', async () => {
        const room = createSyncRoom();
        await deliverSyncRequest(room, 'first');
        await vi.advanceTimersByTimeAsync(100);
        await deliverSyncRequest(room, 'second');
        await vi.advanceTimersByTimeAsync(100);
        await deliverSyncRequest(room, 'third');

        await vi.advanceTimersByTimeAsync(49);
        await settleTurns();
        expect(room.director.application.syncRequests).toEqual([
            { reason: 'first' },
            { reason: 'second' },
            { reason: 'third' }
        ]);
        expect(readSentSnapshots(room.director.page)).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        await settleTurns();
        expect(readSentSnapshots(room.director.page)).toEqual([{ revision: 1 }]);
    });

    it('reads the snapshot when the window closes, after the last request it answers', async () => {
        const room = createSyncRoom();
        await deliverSyncRequest(room, 'first');
        await deliverSyncRequest(room, 'second');
        room.director.application.snapshot = { revision: 2 };

        await vi.advanceTimersByTimeAsync(250);
        await settleTurns();

        expect(readSentSnapshots(room.director.page)).toEqual([{ revision: 2 }]);
        expect(room.director.application.snapshotReads).toBe(1);
    });

    it('opens a new window for a request that arrives after the last one closed', async () => {
        const room = createSyncRoom();
        await deliverSyncRequest(room, 'first');
        await vi.advanceTimersByTimeAsync(251);
        await deliverSyncRequest(room, 'second');
        await settleTurns();
        expect(readSentSnapshots(room.director.page)).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(249);
        await settleTurns();
        expect(readSentSnapshots(room.director.page)).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        await settleTurns();
        expect(readSentSnapshots(room.director.page)).toHaveLength(2);
    });

    it('sends no snapshot and leaves no timer once the relay stopped inside the window', async () => {
        const room = createSyncRoom();
        await deliverSyncRequest(room, 'first');
        room.client.stop();

        room.director.relay.stop();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(250);
        await settleTurns();

        expect(readSentSnapshots(room.director.page)).toEqual([]);
    });

    it('sends no snapshot and leaves no window timer once the appointment moved to another session inside the window', async () => {
        const room = createSyncRoom();
        const timersBeforeRequest = vi.getTimerCount();
        await deliverSyncRequest(room, 'first');

        room.directorSnapshots.splice(0, 1, createRoomSnapshot('successor-session', 2));
        await vi.advanceTimersByTimeAsync(250);
        await settleTurns();

        expect(readSentSnapshots(room.director.page)).toEqual([]);
        expect(vi.getTimerCount()).toBe(timersBeforeRequest);
    });
});

describe('the director\'s own sync request', () => {
    it('opens a window alone and answers with one snapshot 250 ms later', async () => {
        const room = createSyncRoom();

        expect(await room.director.relay.requestSync({ reason: 'own-page' })).toEqual({ status: 'sent' });
        await vi.advanceTimersByTimeAsync(249);
        await settleTurns();
        expect(readSentSnapshots(room.director.page)).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        await settleTurns();
        expect(readSentSnapshots(room.director.page)).toEqual([{ revision: 1 }]);
        expect(room.director.application.syncRequests).toEqual([]);
    });

    it('joins the window of the room\'s requests without putting a request on the wire', async () => {
        const room = createSyncRoom();
        await deliverSyncRequest(room, 'room');

        expect(await room.director.relay.requestSync({ reason: 'own-page' })).toEqual({ status: 'sent' });
        await vi.advanceTimersByTimeAsync(250);
        await settleTurns();

        expect([...room.director.page.sent.rtc, ...room.director.page.sent.ws].filter(isSyncRequest)).toEqual([]);
        expect(room.director.application.syncRequests).toEqual([{ reason: 'room' }]);
        expect(readSentSnapshots(room.director.page)).toEqual([{ revision: 1 }]);
    });

    it('is refused not-director when the director\'s relay reads no snapshot', async () => {
        const room = createSyncRoom(false);

        expect(await room.director.relay.requestSync({ reason: 'own-page' })).toMatchObject({
            status: 'not-director'
        });
    });
});
