import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import type { GroupJoinCodeResponse } from '@shared/api/state-types.ts';

import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { createRoomSnapshot, getRoomWorkflowMocks, resetRoomWorkflowTestRuntime } from './room-workflow-test-runtime.ts';

interface HttpRequest {
    readonly url: string;
    readonly method: string;
    readonly body: object;
}

const runtime = getRoomWorkflowMocks();
const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const roomRef = { ...scope, groupId: 'private-room' };
const requests: HttpRequest[] = [];

installFakeBroadcastChannelPerTest();

describe('private room membership through the browser facade', () => {
    beforeEach(async () => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: '' });
        requests.length = 0;
        const actual = await vi.importActual<typeof import('@shared-web/browser/rooms/room-membership-group-state-workflows.ts')>(
            '@shared-web/browser/rooms/room-membership-group-state-workflows.ts'
        );
        runtime.createStateGroupInvite.mockImplementation(actual.createStateGroupInvite);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('creates and revokes an account invitation through the exact scoped endpoints', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createRoomSnapshot('private-room', ['session-1']);
        respond(() => json(snapshot));
        const facade = createRallarFacade();

        await facade.rooms.invite(roomRef, 'invited-person', { invitationExpiresAtEpochMs: 99_000 });
        await expect(facade.rooms.revokeInvite(roomRef, 'invited-person', { reason: 'Changed plans' })).resolves.toEqual(snapshot);

        expect(requests.map((request) => request.url)).toEqual([
            expect.stringMatching(/\/apps\/app-1\/workspaces\/workspace-1\/groups\/private-room\/invites\/invited-person\/requests\//),
            expect.stringMatching(/\/apps\/app-1\/workspaces\/workspace-1\/groups\/private-room\/invites\/invited-person\/revoke\/requests\//)
        ]);
        expect(requests[0].body).toMatchObject({ invitationExpiresAtEpochMs: 99_000 });
        expect(requests[1]).toMatchObject({ method: 'POST', body: { reason: 'Changed plans', actorPrincipalId: 'principal-1', actorSessionId: 'session-1' } });
        expect(facade.rooms.state().rooms.find((room) => room.roomId === 'private-room')?.snapshot).toEqual(snapshot);
    });

    it('returns the generated code and authoritative expiry while accepting its snapshot', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const result: GroupJoinCodeResponse = { joinCode: 'NEW-CODE', expiresAtEpochMs: 99_000, snapshot: createRoomSnapshot('private-room', ['session-1']) };
        respond(() => json(result));
        const facade = createRallarFacade();

        await expect(facade.rooms.rotateJoinCode(roomRef)).resolves.toEqual(result);

        expect(requests[0].url).toMatch(/\/apps\/app-1\/workspaces\/workspace-1\/groups\/private-room\/join-code\/rotate\/requests\//);
        expect(requests[0].body).toEqual({ actorPrincipalId: 'principal-1', actorSessionId: 'session-1' });
        expect(facade.rooms.state().rooms.find((room) => room.roomId === 'private-room')?.snapshot).toEqual(result.snapshot);
    });

    it('preserves one idempotency key and the requested code and expiry across a retry', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const result: GroupJoinCodeResponse = { joinCode: 'CHOSEN', expiresAtEpochMs: 99_000, snapshot: createRoomSnapshot('private-room', []) };
        respond(() => requests.length === 1 ? new Response('unavailable', { status: 503 }) : json(result));

        await expect(createRallarFacade().rooms.rotateJoinCode(roomRef, { joinCode: 'CHOSEN', expiresAtEpochMs: 99_000, maxAttempts: 2 })).resolves.toEqual(
            result
        );

        expect(requests).toHaveLength(2);
        expect(requests[0]).toEqual(requests[1]);
        expect(requests[0].body).toMatchObject({ joinCode: 'CHOSEN', expiresAtEpochMs: 99_000 });
    });

    it.each(['invite', 'revoke', 'rotate'] as const)('does not publish an obsolete account result from %s', async (operation) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createRoomSnapshot('private-room', ['session-1']);
        respond(() => {
            runtime.readSession.mockReturnValue({ ...runtime.session, clientId: 'other-principal', sessionId: 'other-session' });
            return json(operation === 'rotate' ? { joinCode: 'OBSOLETE', expiresAtEpochMs: 99_000, snapshot } : snapshot);
        });
        const facade = createRallarFacade();
        const pending = operation === 'rotate'
            ? facade.rooms.rotateJoinCode(roomRef)
            : operation === 'revoke'
            ? facade.rooms.revokeInvite(roomRef, 'invited-person')
            : facade.rooms.invite(roomRef, 'invited-person');

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

        expect(facade.rooms.state().rooms.some((room) => room.roomId === 'private-room')).toBe(false);
    });

    it('preserves a denied rotation as a failure without producing a replacement code', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respond(() => new Response('denied', { status: 403 }));

        await expect(createRallarFacade().rooms.rotateJoinCode(roomRef, { maxAttempts: 3 })).rejects.toMatchObject({ status: 403 });

        expect(requests).toHaveLength(1);
    });

    it.each(['invite', 'revoke', 'rotate'] as const)('stops retrying %s if the initiating account is replaced', async (operation) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respond(() => {
            runtime.readSession.mockReturnValue({ ...runtime.session, clientId: 'other-principal', sessionId: 'other-session' });
            return new Response('unavailable', { status: 503 });
        });
        const facade = createRallarFacade();
        const options = { maxAttempts: 3 };
        const pending = operation === 'rotate'
            ? facade.rooms.rotateJoinCode(roomRef, options)
            : operation === 'revoke'
            ? facade.rooms.revokeInvite(roomRef, 'invited-person', options)
            : facade.rooms.invite(roomRef, 'invited-person', options);

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(requests).toHaveLength(1);
    });
});

function respond(handler: (request: HttpRequest) => Response): void {
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const request: HttpRequest = { url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) };
        requests.push(request);
        return handler(request);
    });
}

function json(value: object): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}
