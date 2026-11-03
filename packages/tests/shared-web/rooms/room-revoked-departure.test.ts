import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { createRoomSnapshot, getRoomWorkflowMocks, resetRoomWorkflowTestRuntime, seedRoomSnapshots } from './room-workflow-test-runtime.ts';

const runtime = getRoomWorkflowMocks();
const previous = createRoomSnapshot('previous', ['session-1']);
let destination = createRoomSnapshot('destination', ['session-1']);
installFakeBroadcastChannelPerTest();

beforeEach(async () => {
    resetRoomWorkflowTestRuntime();
    destination = createRoomSnapshot('destination', ['session-1']);
    configureApiClient({ apiBaseUrl: '' });
    const actual = await vi.importActual<typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts')>(
        '@shared-web/browser/rooms/room-group-state-workflows.ts'
    );
    runtime.leaveStateGroup.mockImplementation(actual.leaveStateGroup);
    runtime.joinStateGroup.mockImplementation(actual.joinStateGroup);
    seedRoomSnapshots([previous]);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe.each(['member-banned', 'member-removed'])('%s departure', (code) => {
    it.each(['rooms', 'session'])('clears current selection through %s without inventing a membership snapshot', async (surface) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respondToDeparture(code, 403);
        const facade = createRallarFacade();
        expect(facade.rooms.current()?.group.groupId).toBe('previous');
        const leave = surface === 'rooms' ? facade.rooms.leave() : facade.rooms.session(previous.group).leave();

        await expect(leave).resolves.toBeUndefined();
        expect(facade.rooms.state().currentRoomRef).toBeUndefined();
        expect(facade.rooms.list()[0]?.snapshot).toEqual(previous);
    });

    it('clears the selected room when an authoritative refresh denies access', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'forbidden', code }), { status: 403 }));
        const facade = createRallarFacade();
        await expect(facade.rooms.session(previous.group).refresh()).rejects.toMatchObject({ status: 403 });
        expect(facade.rooms.state().currentRoomRef).toBeUndefined();
    });

    it('keeps a newly admitted destination when the source membership refuses departure', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respondToDeparture(code, 403);
        const facade = createRallarFacade();
        expect(await facade.rooms.join(destination.group)).toEqual(destination);
        expect(facade.rooms.current()?.group.groupId).toBe('destination');
    });
});

it.each([
    ['forbidden', 403],
    ['member-banned', 500],
    ['member-not-found', 404]
])('preserves an unrelated departure failure (%s, %s)', async (code, status) => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    respondToDeparture(String(code), Number(status));
    const facade = createRallarFacade();
    await expect(facade.rooms.leave()).rejects.toMatchObject({ status });
    expect(facade.rooms.current()?.group.groupId).toBe('previous');
});

it('does not clear a replacement session when an old leave response arrives', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        if (String(input).includes('/members/')) {
            started.resolve();
            return await response.promise;
        }
        return new Response('missing', { status: 404 });
    });
    const facade = createRallarFacade();
    const leaving = facade.rooms.leave();
    const rejected = expect(leaving).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    runtime.readSession.mockReturnValue({ ...runtime.session, sessionId: 'replacement-session' });
    response.resolve(new Response(JSON.stringify({ error: 'forbidden', code: 'member-banned' }), { status: 403 }));
    await rejected;
});

it('preserves a newer same-room observation when an old refresh is denied', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', async () => {
        started.resolve();
        return await response.promise;
    });
    const facade = createRallarFacade();
    const refreshing = facade.rooms.session(previous.group).refresh();
    const rejected = expect(refreshing).rejects.toMatchObject({ status: 403 });
    await started.promise;
    const newer = { ...previous, causalRevision: { ...previous.causalRevision, groupRevision: 2 }, group: { ...previous.group, snapshotVersion: 2 } };
    seedRoomSnapshots([newer]);
    response.resolve(new Response(JSON.stringify({ error: 'forbidden', code: 'member-banned' }), { status: 403 }));
    await rejected;
    expect(facade.rooms.current()).toEqual(newer);
});

function respondToDeparture(code: string, status: number): void {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/members/')) {
            return new Response(JSON.stringify({ error: 'forbidden', code }), { status });
        }
        if (url.includes('/disconnect/')) {
            return new Response('missing', { status: 404 });
        }
        if (init?.method === 'PUT') {
            const request = requireRecord(JSON.parse(String(init.body)), 'Presence request');
            const generationId = request.generationId;
            requireString(generationId, 'generationId');
            destination = {
                ...destination,
                activeSessions: destination.activeSessions.map((presence) => ({
                    ...presence,
                    generationId,
                    expiresAtEpochMs: Date.now() + 120_000
                }))
            };
        }
        return new Response(JSON.stringify(destination), { headers: { 'content-type': 'application/json' } });
    });
}
