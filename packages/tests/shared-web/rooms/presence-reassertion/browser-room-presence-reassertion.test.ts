import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { BrowserRoomPresenceReassertion } from '@shared-web/browser/rooms/presence-reassertion/browser-room-presence-reassertion.ts';
import {
    setBrowserStateReadDiagnosticsSink,
    type BrowserStateReadDiagnosticEvent
} from '@shared-web/browser/state-read/diagnostics.ts';
import { requireEpoch, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupMove } from '@shared/api/mutation/group-move.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { JsonWebSocketClient, WebSocketClientCallbacks } from '@shared/websocket/json-web-socket-client.ts';

import { createDefaultApiMiddlewareTestDouble } from '../../api-middleware-test-double.ts';
import { createGroupSnapshotFixture } from '../../authoritative-group-fixtures.ts';
import { installFakeBroadcastChannelPerTest } from '../../data/rallar-data-test-runtime.ts';
import {
    createRoomSnapshot,
    getRoomWorkflowMocks,
    resetRoomWorkflowTestRuntime,
    seedRoomSnapshots
} from '../room-workflow-test-runtime.ts';

/** One REST call the facade made, as the room fixture server saw it. */
interface HttpRequest {
    readonly url: string;
    readonly method: string;
    readonly body: object;
}

/**
 * How the fake room answers one presence connect: arrival, a summary that never lists it, an arrival read that fails,
 * or an HTTP refusal.
 */
type PresenceAnswer = 'present' | 'missing' | 'read-failed' | ApiHttpError;

interface RecordedPresenceConnect {
    readonly groupId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly connectionGenerationId: string;
}

const ROOM_REF: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const OTHER_ROOM_REF: GroupRef = { ...ROOM_REF, groupId: 'room-2' };
const SOCKET_CALLBACK_ID = 'rallar:room-presence-reassertion';
const ROOM_SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const MOVE_TO_ROOM: GroupMove = {
    moveId: 'move-1',
    source: { ...ROOM_SCOPE, groupId: 'previous' },
    destination: ROOM_REF,
    organizerSessionId: 'session-1',
    participants: [{
        principalId: 'principal-1',
        sessionId: 'session-1',
        generationId: 'generation-session-1',
        generationVersion: 100,
        confirmedAtEpochMs: 110,
        arrivedAtEpochMs: null
    }],
    createdAtEpochMs: 100,
    expiresAtEpochMs: 120100,
    completedAtEpochMs: 120,
    status: 'committed',
    reason: null,
    admissionFailure: null
};

let connects: RecordedPresenceConnect[];
let answers: Map<string, PresenceAnswer[]>;
let generation: Either<Error, string>;
let socketCallbacks: Map<string, WebSocketClientCallbacks>;
let diagnostics: BrowserStateReadDiagnosticEvent[];
let generationCount: number;
let adopted: GroupSnapshot[];
const roomWorkflow = getRoomWorkflowMocks();

installFakeBroadcastChannelPerTest();

describe('browser room presence re-assertion', () => {
    beforeEach(() => {
        connects = [];
        answers = new Map();
        generation = Either.ofRight('ws-generation-1');
        socketCallbacks = new Map();
        diagnostics = [];
        generationCount = 0;
        adopted = [];
        setBrowserStateReadDiagnosticsSink((event) => diagnostics.push(event));
    });

    afterEach(() => {
        setBrowserStateReadDiagnosticsSink(undefined);
    });

    it('re-asserts a remembered room on every reopen under the new socket generation', async () => {
        const owner = createAttachedOwner();
        owner.rememberEnteredRoom(ROOM_REF);

        generation = Either.ofRight('ws-generation-2');
        await reopenSocket();
        generation = Either.ofRight('ws-generation-3');
        await reopenSocket();

        expect(connects).toEqual([
            presenceConnect('room-1', 'presence-generation-1', 'ws-generation-2'),
            presenceConnect('room-1', 'presence-generation-2', 'ws-generation-3')
        ]);
        expect(reassertionResults()).toEqual(['reasserted', 'reasserted']);
    });

    it('does not re-assert a forgotten room', async () => {
        const owner = createAttachedOwner();
        owner.rememberEnteredRoom(ROOM_REF);
        owner.rememberEnteredRoom(OTHER_ROOM_REF);
        owner.forgetEnteredRoom({ ...ROOM_REF });

        await reopenSocket();

        expect(connects.map((connect) => connect.groupId)).toEqual(['room-2']);
    });

    it('re-asserts an inactive answer once with a fresh generation, then forgets the room and says so', async () => {
        const owner = createAttachedOwner();
        owner.rememberEnteredRoom(ROOM_REF);
        answers.set('room-1', ['missing', 'missing']);

        await reopenSocket();
        await reopenSocket();

        expect(connects).toEqual([
            presenceConnect('room-1', 'presence-generation-1', 'ws-generation-1'),
            presenceConnect('room-1', 'presence-generation-2', 'ws-generation-1')
        ]);
        expect(reassertionResults()).toEqual(['inactive']);
    });

    it('keeps the room when the fresh re-assert arrives', async () => {
        const owner = createAttachedOwner();
        owner.rememberEnteredRoom(ROOM_REF);
        answers.set('room-1', ['missing', 'present']);

        await reopenSocket();
        await reopenSocket();

        expect(connects.map((connect) => connect.generationId)).toEqual([
            'presence-generation-1',
            'presence-generation-2',
            'presence-generation-3'
        ]);
        expect(reassertionResults()).toEqual(['reasserted', 'reasserted']);
    });

    it('forgets a room whose re-assert the server refuses, and says so', async () => {
        const owner = createAttachedOwner();
        owner.rememberEnteredRoom(ROOM_REF);
        answers.set('room-1', [toPolicyDenial('member-removed')]);

        await reopenSocket();
        await reopenSocket();

        expect(connects).toHaveLength(1);
        expect(reassertionResults()).toEqual(['refused']);
    });

    it('adopts the room snapshot a re-assert arrived in, so the heartbeat lists the room at once', async () => {
        const owner = createAttachedOwner();
        owner.rememberEnteredRoom(ROOM_REF);

        await reopenSocket();

        expect(adopted.map((snapshot) => snapshot.activeSessions.map((session) => session.sessionId))).toEqual([
            ['session-1']
        ]);
    });

    it('keeps the room and says the read failed when the arrival read fails after a successful connect', async () => {
        const owner = createAttachedOwner();
        owner.rememberEnteredRoom(ROOM_REF);
        answers.set('room-1', ['read-failed', 'read-failed']);

        await reopenSocket();
        await reopenSocket();
        await reopenSocket();

        expect(connects).toHaveLength(3);
        expect(adopted).toHaveLength(1);
        expect(reassertionResults()).toEqual(['read-failed', 'read-failed', 'reasserted']);
    });

    it('keeps the room for the next reopen when a newer socket overtook the re-assert or the network failed', async () => {
        const owner = createAttachedOwner();
        owner.rememberEnteredRoom(ROOM_REF);
        answers.set('room-1', [toPolicyDenial('stale-generation'), new ApiHttpError('PUT', '/presence', 503, '{}')]);

        await reopenSocket();
        await reopenSocket();
        await reopenSocket();

        expect(connects).toHaveLength(3);
        expect(reassertionResults()).toEqual(['reasserted']);
    });

    it('sends nothing while the reopened socket generation cannot be read', async () => {
        const owner = createAttachedOwner();
        owner.rememberEnteredRoom(ROOM_REF);
        generation = Either.ofLeft(new Error('The WebSocket reconnected while its generation was read.'));

        await reopenSocket();

        expect(connects).toEqual([]);
        expect(reassertionResults()).toEqual([]);
    });

    it('forgets every room and stops listening when the connection detaches', async () => {
        const owner = createAttachedOwner();
        owner.rememberEnteredRoom(ROOM_REF);

        owner.detach();
        expect(socketCallbacks.has(SOCKET_CALLBACK_ID)).toBe(false);
        owner.attach(createContext());
        await reopenSocket();

        expect(connects).toEqual([]);
    });
});

type FacadeRooms = Awaited<ReturnType<typeof createFacadeOnRoomServer>>['rooms'];

/** Each room flow that connects presence, entering room-1 from a page whose current room is `previous`. */
const ENTERING_FLOWS: readonly Readonly<{ name: string; enter: (rooms: FacadeRooms) => Promise<void>; }>[] = [
    {
        name: 'join',
        enter: async (rooms) => {
            await rooms.join({ roomRef: ROOM_REF, leaveCurrent: false });
        }
    },
    {
        name: 'create-and-join',
        enter: async (rooms) => {
            await rooms.create({ displayName: 'Room one', groupId: 'room-1' });
        }
    },
    {
        name: 'quick join',
        enter: async (rooms) => {
            await rooms.quickJoin({ scope: ROOM_SCOPE, leaveCurrent: false });
        }
    },
    {
        name: 'invite accept',
        enter: async (rooms) => {
            await rooms.acceptInvite(ROOM_REF);
        }
    },
    {
        name: 'group move',
        enter: async (rooms) => {
            await rooms.activateMove(MOVE_TO_ROOM);
        }
    }
];

describe('room flows keep the entered-rooms register', () => {
    let requests: HttpRequest[];

    beforeEach(async () => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: '' });
        requests = [];
        diagnostics = [];
        setBrowserStateReadDiagnosticsSink((event) => diagnostics.push(event));
        const actual = await vi.importActual<typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts')>(
            '@shared-web/browser/rooms/room-group-state-workflows.ts'
        );
        roomWorkflow.joinStateGroup.mockImplementation(actual.joinStateGroup);
        roomWorkflow.leaveStateGroup.mockImplementation(actual.leaveStateGroup);
        roomWorkflow.createAndJoinStateGroup.mockResolvedValue(createRoomSnapshot('room-1', ['session-1']));
        roomWorkflow.acceptStateGroupInvite.mockResolvedValue(createRoomSnapshot('room-1', ['session-1']));
        seedRoomSnapshots([createRoomSnapshot('previous', ['session-1'])]);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setBrowserStateReadDiagnosticsSink(undefined);
    });

    it.each(ENTERING_FLOWS)('$name remembers the room it entered, so a socket reopen re-asserts it', async (flow) => {
        const facade = await createFacadeOnRoomServer(requests);
        await flow.enter(facade.rooms);
        const entered = requests.filter(isRoomOnePresenceConnect).length;

        await reopenFacadeSocket();

        await vi.waitFor(() => expect(requests.filter(isRoomOnePresenceConnect)).toHaveLength(entered + 1));
    });

    it('a joined room re-asserts its presence on a socket reopen until the page leaves it', async () => {
        const facade = await createFacadeOnRoomServer(requests);
        await facade.rooms.join({ roomRef: ROOM_REF, leaveCurrent: false });
        const joinedGeneration = requireRecord(requests.filter(isRoomOnePresenceConnect).at(-1)?.body, 'Joined presence')
            .generationId;

        await reopenFacadeSocket();
        await vi.waitFor(() => expect(requests.filter(isRoomOnePresenceConnect)).toHaveLength(2));
        const reasserted = requireRecord(requests.filter(isRoomOnePresenceConnect)[1]?.body, 'Re-asserted presence');
        expect(reasserted.connectionGenerationId).toBe('ws-generation-session-1');
        expect(reasserted.generationId).not.toBe(joinedGeneration);

        await facade.rooms.leave({ roomRef: ROOM_REF });
        await reopenFacadeSocket();
        expect(requests.filter(isRoomOnePresenceConnect)).toHaveLength(2);
    });

    it('the re-asserted room snapshot is cached at once, listing the session under its new generation', async () => {
        const facade = await createFacadeOnRoomServer(requests);
        await facade.rooms.join({ roomRef: ROOM_REF, leaveCurrent: false });

        await reopenFacadeSocket();
        await vi.waitFor(() => expect(requests.filter(isRoomOnePresenceConnect)).toHaveLength(2));
        const reasserted = requireRecord(requests.filter(isRoomOnePresenceConnect)[1]?.body, 'Re-asserted presence');

        await vi.waitFor(() =>
            expect(
                facade.rooms.list().find((room) => room.snapshot.group.groupId === 'room-1')?.snapshot.activeSessions
                    .map((session) => [session.sessionId, session.generationId])
            ).toEqual([['session-1', reasserted.generationId]])
        );
    });

    it('a failed arrival read keeps the room for the next reopen instead of reading it as inactive', async () => {
        const facade = await createFacadeOnRoomServer(requests, { failArrivalReads: true });
        await facade.rooms.join({ roomRef: ROOM_REF, leaveCurrent: false });

        await reopenFacadeSocket();
        await vi.waitFor(() => expect(reassertionResults()).toEqual(['read-failed']), { timeout: 10_000 });
        await reopenFacadeSocket();

        await vi.waitFor(() => expect(requests.filter(isRoomOnePresenceConnect)).toHaveLength(3));
    });

    it('a new connection\'s first open re-asserts nothing the earlier connection entered', async () => {
        const facade = await createFacadeOnRoomServer(requests);
        await facade.rooms.join({ roomRef: ROOM_REF, leaveCurrent: false });

        await facade.disconnect();
        await facade.connect();
        await reopenFacadeSocket();

        expect(requests.filter(isRoomOnePresenceConnect)).toHaveLength(1);
    });
});

/** A facade over a fixture room server that admits room-1 and publishes each presence connect's generation. */
async function createFacadeOnRoomServer(
    requests: HttpRequest[],
    server: Readonly<{ failArrivalReads: boolean; }> = { failArrivalReads: false }
) {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    let room = createRoomSnapshot('room-1', ['session-1']);
    let entered = false;
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const request = {
            url: String(url),
            method: init?.method ?? 'GET',
            body: requireRecord(JSON.parse(String(init?.body ?? '{}')), 'Room request')
        };
        requests.push(request);
        if (request.url.includes('/groups/previous/')) {
            const previous = createRoomSnapshot('previous', ['session-1']);
            return toJsonResponse(withNextPresenceRevision({ ...previous, activeSessions: [], onlineMemberCount: 0 }));
        }
        if (server.failArrivalReads && entered) {
            // The re-assert commits but its answer and every arrival read fail, so nothing can tell it arrived.
            return request.method === 'GET'
                ? new Response('unavailable', { status: 503 })
                : toJsonResponse(room);
        }
        entered = entered || isRoomOnePresenceConnect(request);
        room = isRoomOnePresenceConnect(request) ? withPresenceGeneration(room, request) : room;
        return toJsonResponse(request.url.includes('/groups/quick-join/requests/') ? { status: 'joined', snapshot: room } : room);
    });
    const facade = createRallarFacade();
    onTestFinished(async () => await facade.disconnect());
    return facade;
}

function toJsonResponse(value: object): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function reopenFacadeSocket(): Promise<void> {
    const registrations = vi.mocked(roomWorkflow.context.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo)
        .mock.calls.filter(([id]) => id === SOCKET_CALLBACK_ID);
    registrations.at(-1)?.[1].onOpen?.(new Event('open'));
    await settle();
}

function isRoomOnePresenceConnect(request: HttpRequest): boolean {
    return request.method === 'PUT' && request.url.includes('/groups/room-1/sessions/');
}

/** The fixture server publishes the generation and lease of a presence connect at the next presence revision. */
function withPresenceGeneration(snapshot: GroupSnapshot, request: HttpRequest): GroupSnapshot {
    const { generationId, expiresAtEpochMs } = requireRecord(request.body, 'Presence request');
    requireString(generationId, 'generationId');
    requireEpoch(expiresAtEpochMs, 'expiresAtEpochMs');
    const next = withNextPresenceRevision(snapshot);
    return {
        ...next,
        activeSessions: next.activeSessions.map((presence) => ({ ...presence, generationId, expiresAtEpochMs }))
    };
}

function withNextPresenceRevision(snapshot: GroupSnapshot): GroupSnapshot {
    const presenceRevision = snapshot.causalRevision.presenceRevision + 1;
    return {
        ...snapshot,
        causalRevision: { ...snapshot.causalRevision, presenceRevision },
        group: { ...snapshot.group, presenceVersion: presenceRevision }
    };
}

function createOwner(): BrowserRoomPresenceReassertion {
    const answered = new Map<string, PresenceAnswer>();
    return new BrowserRoomPresenceReassertion({
        presence: {
            connectPresence: async (request) => {
                connects.push({
                    groupId: request.roomRef.groupId,
                    sessionId: request.context.session.sessionId,
                    generationId: request.generationId,
                    connectionGenerationId: request.connectionGenerationId
                });
                const answer = answers.get(request.roomRef.groupId)?.shift() ?? 'present';
                if (answer instanceof ApiHttpError) {
                    throw answer;
                }
                answered.set(request.generationId, answer);
                return createGroupSnapshotFixture({
                    ...request.roomRef,
                    sessionIds: answer === 'missing' ? [] : ['session-1']
                });
            },
            readSessionArrival: async (snapshot, request) =>
                answered.get(request.generationId) === 'read-failed'
                    ? Either.ofLeft(new ApiHttpError('GET', '/groups/room-1', 503, '{}'))
                    : Either.ofRight(
                        snapshot.activeSessions.length > 0 ? { status: 'arrived', snapshot } : { status: 'absent' }
                    ),
            adoptRoomSnapshot: async (snapshot) => {
                adopted.push(snapshot);
            }
        },
        readPublicationKey: async () => null,
        newGenerationId: () => `presence-generation-${++generationCount}`
    });
}

function createAttachedOwner(): BrowserRoomPresenceReassertion {
    const owner = createOwner();
    owner.attach(createContext());
    return owner;
}

function createContext(): ApiMiddleware {
    const socket: Partial<JsonWebSocketClient> = {
        onWebsocketCallbacksDo: (id, callbacks) => {
            socketCallbacks.set(id, callbacks);
            return socket as JsonWebSocketClient;
        },
        removeWebsocketCallbackById: (id) => socketCallbacks.delete(id)
    };
    return createDefaultApiMiddlewareTestDouble({
        middleware: {
            ownWsConnectionGeneration: {
                read: async () => generation,
                readKnown: () => generation.right
            },
            webSocketQueueBox: { socket: socket as JsonWebSocketClient }
        }
    });
}

async function reopenSocket(): Promise<void> {
    socketCallbacks.get(SOCKET_CALLBACK_ID)?.onOpen?.(new Event('open'));
    await settle();
}

async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

function presenceConnect(groupId: string, generationId: string, connectionGenerationId: string): RecordedPresenceConnect {
    return { groupId, sessionId: 'session-1', generationId, connectionGenerationId };
}

function reassertionResults(): readonly string[] {
    return diagnostics
        .filter((event) => event.operation === 'room-presence-reassertion')
        .map((event) => event.result);
}

function toPolicyDenial(code: string): ApiHttpError {
    return new ApiHttpError(
        'PUT',
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/sessions/session-1/requests/presence',
        403,
        JSON.stringify({
            type: 'api-mutation-failure',
            version: 'canonical.v2',
            code,
            status: 403,
            message: code,
            issues: null,
            denial: { code, message: code, details: null },
            retry: null
        })
    );
}
