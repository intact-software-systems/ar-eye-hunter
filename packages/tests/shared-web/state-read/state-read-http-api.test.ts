import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { refreshStateSnapshots } from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import {
    listStateClientEventPage,
    listStateClientEvents,
    listStateGroupEventPage,
    listStateGroupEvents
} from '@shared-web/browser/state-read/state-event-http-api.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientSnapshotFixture, createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

describe('state-read HTTP API', () => {
    beforeEach(installEmptyLocalStorage);

    afterEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('refreshes client and group collections from the configured origin', async () => {
        const urls: string[] = [];
        const clients = [createClientSnapshotFixture({
            applicationId: 'rallar-server',
            workspaceId: 'default',
            principalId: 'principal-1'
        })];
        const groups = [createGroupSnapshotFixture({
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'group-1',
            sessionIds: []
        })];
        configureApiClient({ apiBaseUrl: 'https://api.example.test/' });
        stubFetch(urls, (url) => jsonResponse(url.endsWith('/clients') ? clients : groups));

        await expect(refreshStateSnapshots()).resolves.toEqual({ clients, groups });

        expect(urls).toEqual([
            'https://api.example.test/api/state/apps/rallar-server/workspaces/default/clients',
            'https://api.example.test/api/state/apps/rallar-server/workspaces/default/groups'
        ]);
    });

    it('encodes entity IDs and event-list filters', async () => {
        const urls: string[] = [];
        const scope = { applicationId: 'app 1', workspaceId: 'workspace/1' };
        const groupEvents = [groupEvent('group-event-1', 'member-joined', 'room /1', scope)];
        const clientEvents = [clientEvent(
            'client-event-1',
            'session-connected',
            'alice@example.test',
            scope
        )];
        stubFetch(urls, (url) => jsonResponse(url.includes('/groups/') ? groupEvents : clientEvents));

        await expect(listStateGroupEvents('room /1', scope, {
            eventTypes: ['member-joined', 'member-left'],
            limit: 10
        })).resolves.toEqual(groupEvents);
        await expect(listStateClientEvents('alice@example.test', scope, {
            eventTypes: ['session-connected'],
            limit: 5
        })).resolves.toEqual(clientEvents);

        expect(urls).toEqual([
            '/api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/events' +
            '?eventType=member-joined&eventType=member-left&limit=10',
            '/api/state/apps/app%201/workspaces/workspace%2F1/clients/alice%40example.test/events' +
            '?eventType=session-connected&limit=5'
        ]);
    });

    it('encodes cursor filters for group and client event pages', async () => {
        const urls: string[] = [];
        const scope = { applicationId: 'app 1', workspaceId: 'workspace/1' };
        const groupPage = {
            events: [groupEvent('group-event-2', 'member-left', 'room /1', scope)],
            nextCursor: { snapshotVersion: 2, occurredAtEpochMs: 2_000, eventId: 'group-event-2' },
            hasMore: false
        };
        const clientPage = {
            events: [clientEvent(
                'client-event-2',
                'session-disconnected',
                'alice@example.test',
                scope
            )],
            nextCursor: { snapshotVersion: 3, occurredAtEpochMs: 3_000, eventId: 'client-event-2' },
            hasMore: true
        };
        stubFetch(urls, (url) => jsonResponse(url.includes('/groups/') ? groupPage : clientPage));

        await expect(listStateGroupEventPage('room /1', scope, {
            eventTypes: ['member-left'],
            limit: 10,
            after: { snapshotVersion: 1, occurredAtEpochMs: 1_000, eventId: 'group-event-1' }
        })).resolves.toEqual(groupPage);
        await expect(listStateClientEventPage('alice@example.test', scope, {
            eventTypes: ['session-disconnected'],
            limit: 5,
            after: { snapshotVersion: 2, occurredAtEpochMs: 2_000, eventId: 'client-event-1' }
        })).resolves.toEqual(clientPage);

        expect(urls).toEqual([
            '/api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/events/page' +
            '?eventType=member-left&limit=10&afterSnapshotVersion=1' +
            '&afterOccurredAtEpochMs=1000&afterEventId=group-event-1',
            '/api/state/apps/app%201/workspaces/workspace%2F1/clients/alice%40example.test/events/page' +
            '?eventType=session-disconnected&limit=5&afterSnapshotVersion=2' +
            '&afterOccurredAtEpochMs=2000&afterEventId=client-event-1'
        ]);
    });

    it('rejects malformed authoritative event lists and pages', async () => {
        const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
        stubFetch([], (url) => {
            if (url.includes('/groups/')) {
                return jsonResponse([{
                    ...groupEvent('group-event-1', 'member-joined', 'room-1', scope),
                    actor: { kind: 'service', serviceId: '' }
                }]);
            }
            return jsonResponse({
                events: [{
                    ...clientEvent('client-event-1', 'session-connected', 'alice', scope),
                    snapshotVersion: 1.5
                }],
                nextCursor: { snapshotVersion: 1, occurredAtEpochMs: 1, eventId: 'client-event-1' },
                hasMore: false
            });
        });

        await expect(listStateGroupEvents('room-1', scope)).rejects.toThrow(/actor|serviceId/);
        await expect(listStateClientEventPage('alice', scope)).rejects.toThrow(/snapshotVersion/);
    });

    it('passes command timeout aborts into collection fetches', async () => {
        vi.useFakeTimers();
        const signals: AbortSignal[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
                if (init?.signal) {
                    signals.push(init.signal);
                }
                return new Promise<Response>(() => {});
            })
        );

        const run = refreshStateSnapshots(undefined, {
            command: { timeoutMs: 10, shouldRetry: () => false }
        });
        const expectation = expect(run).rejects.toThrow('Command timed out after 10 ms');
        await vi.advanceTimersByTimeAsync(10);

        await expectation;
        expect(signals).toHaveLength(2);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
    });

    it('exposes HTTP status and response text for retry classification', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('temporarily unavailable', { status: 503 }))
        );

        await expect(refreshStateSnapshots()).rejects.toMatchObject({
            status: 503,
            method: 'GET',
            bodyText: 'temporarily unavailable'
        });
    });

    it('preserves parsed policy errors on HTTP failures', async () => {
        const { readApiPolicyError } = await import('@shared-web/browser/api/http-error.ts');
        const body = {
            error: 'Forbidden: Invite required.',
            code: 'group-invite-required',
            message: 'Invite required.',
            details: { groupId: 'room-1' }
        };
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                new Response(JSON.stringify(body), {
                    status: 403,
                    headers: { 'content-type': 'application/json' }
                })
            )
        );

        let capturedError: object | undefined;
        try {
            await refreshStateSnapshots();
        }
        catch (error) {
            if (typeof error === 'object' && error !== null) {
                capturedError = error;
            }
        }

        expect(capturedError).toMatchObject({
            status: 403,
            bodyText: JSON.stringify(body),
            policyError: body
        });
        expect(readApiPolicyError(capturedError)).toMatchObject({
            code: 'group-invite-required',
            message: 'Invite required.'
        });
    });
});

function stubFetch(urls: string[], respond: (url: string) => Response): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            urls.push(url);
            return respond(url);
        })
    );
}

function jsonResponse(body: object): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function groupEvent(
    eventId: string,
    eventType: GroupEvent['eventType'],
    groupId: string,
    scope: Readonly<{ applicationId: string; workspaceId: string; }>
): GroupEvent {
    return {
        ...scope,
        groupId,
        eventId,
        eventType,
        snapshotVersion: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        occurredAtEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

function clientEvent(
    eventId: string,
    eventType: ClientEvent['eventType'],
    principalId: string,
    scope: Readonly<{ applicationId: string; workspaceId: string; }>
): ClientEvent {
    return {
        ...scope,
        principalId,
        eventId,
        eventType,
        snapshotVersion: 1,
        clientInstanceId: null,
        sessionId: null,
        occurredAtEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

function installEmptyLocalStorage(): void {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn()
    });
}
