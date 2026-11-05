import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { Either } from '@shared/resilience/Either.ts';
import type { JsonWebSocketClient, WebSocketClientCallbacks } from '@shared/websocket/json-web-socket-client.ts';

import { createDefaultApiMiddlewareTestDouble } from '../../api-middleware-test-double.ts';
import { createGroupSnapshotFixture } from '../../authoritative-group-fixtures.ts';
import { installFakeBroadcastChannelPerTest } from '../../data/rallar-data-test-runtime.ts';
import { createRoomSnapshot, getRoomWorkflowMocks, resetRoomWorkflowTestRuntime } from '../room-workflow-test-runtime.ts';

/** One REST call the facade made, as the room fixture server saw it. */
interface HttpRequest {
    readonly url: string;
    readonly method: string;
    readonly body: object;
}

/** How the fake room answers one presence connect: arrival, a summary that never lists it, or an HTTP refusal. */
type PresenceAnswer = 'present' | 'missing' | ApiHttpError;

interface RecordedPresenceConnect {
    readonly groupId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly connectionGenerationId: string;
}

const ROOM_REF: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const OTHER_ROOM_REF: GroupRef = { ...ROOM_REF, groupId: 'room-2' };
const SOCKET_CALLBACK_ID = 'rallar:room-presence-reassertion';

let connects: RecordedPresenceConnect[];
let answers: Map<string, PresenceAnswer[]>;
let generation: Either<Error, string>;
let socketCallbacks: Map<string, WebSocketClientCallbacks>;
let diagnostics: BrowserStateReadDiagnosticEvent[];
let generationCount: number;
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
        setBrowserStateReadDiagnosticsSink((event) => diagnostics.push(event));
    });

    afterEach(() => {
        setBrowserStateReadDiagnosticsSink(undefined);
    });

    it('re-asserts a remembered room on a reopen under the new socket generation, never on the initial connect', async () => {
        const owner = createOwner();
        owner.rememberEnteredRoom(ROOM_REF);
        owner.attach(createContext());
        await settle();
        expect(connects).toEqual([]);

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

describe('room flows keep the entered-rooms register', () => {
    const requests: HttpRequest[] = [];

    beforeEach(async () => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: '' });
        requests.length = 0;
        const actual = await vi.importActual<typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts')>(
            '@shared-web/browser/rooms/room-group-state-workflows.ts'
        );
        roomWorkflow.joinStateGroup.mockImplementation(actual.joinStateGroup);
        roomWorkflow.leaveStateGroup.mockImplementation(actual.leaveStateGroup);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('a joined room re-asserts its presence on a socket reopen until the page leaves it', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        let room = createRoomSnapshot('room-1', ['session-1']);
        vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
            const request = {
                url: String(url),
                method: init?.method ?? 'GET',
                body: requireRecord(JSON.parse(String(init?.body ?? '{}')), 'Room request')
            };
            requests.push(request);
            room = isPresenceConnect(request) ? withPresenceGeneration(room, request) : room;
            return new Response(JSON.stringify(room), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const facade = createRallarFacade();
        await facade.rooms.join({ roomRef: ROOM_REF, leaveCurrent: false });
        const joinedGeneration = requireRecord(requests.filter(isPresenceConnect).at(-1)?.body, 'Joined presence')
            .generationId;

        await reopenFacadeSocket();
        await vi.waitFor(() => expect(requests.filter(isPresenceConnect)).toHaveLength(2));
        const reasserted = requireRecord(requests.filter(isPresenceConnect)[1]?.body, 'Re-asserted presence');
        expect(reasserted.connectionGenerationId).toBe('ws-generation-session-1');
        expect(reasserted.generationId).not.toBe(joinedGeneration);

        await facade.rooms.leave({ roomRef: ROOM_REF });
        await reopenFacadeSocket();
        await settle();
        expect(requests.filter(isPresenceConnect)).toHaveLength(2);
    });
});

async function reopenFacadeSocket(): Promise<void> {
    const registrations = vi.mocked(roomWorkflow.context.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo)
        .mock.calls.filter(([id]) => id === SOCKET_CALLBACK_ID);
    registrations.at(-1)?.[1].onOpen?.(new Event('open'));
    await settle();
}

function isPresenceConnect(request: HttpRequest): boolean {
    return request.method === 'PUT' && request.url.includes('/sessions/');
}

/** The fixture server publishes the generation and lease of a presence connect at the next presence revision. */
function withPresenceGeneration(snapshot: GroupSnapshot, request: HttpRequest): GroupSnapshot {
    const { generationId, expiresAtEpochMs } = requireRecord(request.body, 'Presence request');
    requireString(generationId, 'generationId');
    requireEpoch(expiresAtEpochMs, 'expiresAtEpochMs');
    const presenceRevision = snapshot.causalRevision.presenceRevision + 1;
    return {
        ...snapshot,
        causalRevision: { ...snapshot.causalRevision, presenceRevision },
        group: { ...snapshot.group, presenceVersion: presenceRevision },
        activeSessions: snapshot.activeSessions.map((presence) => ({ ...presence, generationId, expiresAtEpochMs }))
    };
}

function createOwner(): BrowserRoomPresenceReassertion {
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
                return createGroupSnapshotFixture({
                    ...request.roomRef,
                    sessionIds: answer === 'present' ? ['session-1'] : []
                });
            },
            readSessionPresent: async (snapshot) => snapshot.activeSessions.length > 0
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
