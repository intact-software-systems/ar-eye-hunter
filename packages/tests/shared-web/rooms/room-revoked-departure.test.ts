import type { RoomAccessObservation } from '@shared-web/browser/rallar.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newALUntargetedMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
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
    it('retains explicit selection across presence loss and clears it on authorized departure', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respondToDeparture(code, 403);
        const facade = createRallarFacade();
        expect(facade.rooms.selected()).toBeUndefined();
        await facade.rooms.join(destination.group);
        const selected = facade.rooms.selected();
        expect(selected).toEqual({
            applicationId: destination.group.applicationId,
            workspaceId: destination.group.workspaceId,
            groupId: destination.group.groupId
        });
        seedRoomSnapshots([{ ...destination, activeSessions: [], onlineMemberCount: 0 }]);
        expect(facade.rooms.current()).toBeUndefined();
        expect(facade.rooms.selected()).toEqual(selected);
        await facade.rooms.leave({ roomRef: destination.group });
        expect(facade.rooms.selected()).toBeUndefined();
    });

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
        respondToDeparture(code, 403);
        const facade = createRallarFacade();
        await facade.rooms.join(destination.group);
        expect(facade.rooms.selected()?.groupId).toBe('destination');
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'forbidden', code }), { status: 403 }));
        await expect(facade.rooms.session(destination.group).refresh()).rejects.toMatchObject({ status: 403 });
        expect(facade.rooms.state().currentRoomRef).toBeUndefined();
        expect(facade.rooms.selected()).toBeUndefined();
    });

    it.each(['resume', 'same socket'])('recovers revocation after a snapshot outage via %s', async recovery => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        respondToDeparture(code, 403);
        await facade.rooms.join(destination.group);
        vi.spyOn(facade.ws, 'status').mockReturnValue({ ...facade.ws.status(), isOpen: true });
        const page = new EventTarget();
        vi.stubGlobal('window', page);
        vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
        vi.stubGlobal('navigator', { onLine: true });
        let access = 200;
        vi.stubGlobal('fetch', async () => access !== 200
            ? Response.json({ error: 'unavailable', code }, { status: access })
            : Response.json(destination, { headers: {
                'cache-control': 'no-store', 'rallar-state-source': 'durable',
                'rallar-group-revision': String(destination.causalRevision.groupRevision),
                'rallar-presence-revision': String(destination.causalRevision.presenceRevision)
            } }));
        let observed: RoomAccessObservation | undefined;
        const stop = facade.rooms.watchAccess(destination.group, value => { observed = value; });
        try {
            await vi.waitFor(() => expect(observed).toEqual({ status: 'current' }));
            vi.useFakeTimers();
            access = 503;
            page.dispatchEvent(new Event('pageshow'));
            await vi.waitFor(() => expect(observed).toEqual({ status: 'stale' }));
            expect(facade.rooms.selected()?.groupId).toBe('destination');
            await vi.advanceTimersByTimeAsync(8_000);
            expect(observed).toEqual({ status: 'stale' });
            if (recovery === 'resume') page.dispatchEvent(new Event('pagehide'));
            access = 403;
            if (recovery === 'resume') page.dispatchEvent(new Event('pageshow'));
            await vi.advanceTimersByTimeAsync(8_000);
            await vi.waitFor(() => expect(observed).toEqual({
                status: 'denied', reason: code === 'member-banned' ? 'banned' : 'removed'
            }));
            expect(facade.rooms.selected()).toBeUndefined();
            expect(facade.rooms.current()).toBeUndefined();
            access = 200;
            const { applicationId, workspaceId, groupId } = destination.group;
            const scope = { applicationId, workspaceId };
            const principalId = runtime.session.clientId;
            const changeId = crypto.randomUUID();
            const topic = AppTopics.viewInvalidated;
            const message = newALUntargetedMessage({
                createdAtEpochMs: Date.now(), senderId: 'server', route: newALRoute(topic, principalId, changeId), typeId: topic,
                resource: { version: 1, resource: 'room-access', scope, groupId, principalId, changeId }
            });
            const targeted = { ...message, targets: { mode: 'broadcast', scope: 'principal', principalRef: { ...scope, principalId } } } as const;
            const { webSocketQueueBox } = runtime.context.middleware;
            const inbox = vi.mocked(webSocketQueueBox.onAnyInboxMessageDo).mock.calls.at(-1)![1];
            await inbox.onMessage(targeted, toResourceEntry(topic, targeted));
            await vi.waitFor(() => expect(observed).toEqual({ status: 'current' }));
            expect(facade.rooms.selected()).toBeUndefined();
        }
        finally {
            stop();
            vi.useRealTimers();
        }
    });

    it('keeps a newly admitted destination when the source membership refuses departure', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respondToDeparture(code, 403);
        const facade = createRallarFacade();
        expect(await facade.rooms.join(destination.group)).toEqual(destination);
        expect(facade.rooms.current()?.group.groupId).toBe('destination');
    });
});

it('stops all access notifications when the stale listener disposes during denial', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();
    await facade.connect();
    vi.spyOn(facade.ws, 'status').mockReturnValue({ ...facade.ws.status(), isOpen: true });
    const page = new EventTarget();
    vi.stubGlobal('window', page);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
    let denied = false;
    vi.stubGlobal('fetch', async () => denied
        ? Response.json({ error: 'forbidden', code: 'member-banned' }, { status: 403 })
        : Response.json(previous, { headers: {
            'cache-control': 'no-store', 'rallar-state-source': 'durable',
            'rallar-group-revision': String(previous.causalRevision.groupRevision),
            'rallar-presence-revision': String(previous.causalRevision.presenceRevision)
        } }));
    const lifetime = new AbortController();
    const updates: string[] = [];
    facade.rooms.watchAccess(previous.group, access => {
        updates.push(access.status);
        if (denied && access.status === 'stale') lifetime.abort();
    }, { signal: lifetime.signal });
    try {
        await vi.waitFor(() => expect(updates.at(-1)).toBe('current'));
        denied = true;
        page.dispatchEvent(new Event('pageshow'));
        await vi.waitFor(() => expect(lifetime.signal.aborted).toBe(true));
        expect(updates.at(-1)).toBe('stale');
    } finally {
        lifetime.abort();
        await facade.disconnect();
    }
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
