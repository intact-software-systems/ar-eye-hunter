import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { createAndJoinStateGroup, joinStateGroup } from '@shared-web/browser/rooms/room-group-state-workflows.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface FetchCall {
    readonly url: string;
    readonly method: string;
    readonly body?: object;
}

describe('room presence policy failures', () => {
    beforeEach(installEmptyLocalStorage);

    afterEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('does not repair raw membership when created-room presence is forbidden', async () => {
        const calls: FetchCall[] = [];
        stubFetch(calls, ({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                return jsonResponse(groupSnapshot('group-1'), 201);
            }
            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                return new Response(
                    'Forbidden: group member not found for presence session: principal-1',
                    { status: 403 }
                );
            }
            return jsonResponse(groupSnapshot('group-1'));
        });

        await expect(createAndJoinStateGroup({
            displayName: 'Room 1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            requestedGroupId: 'group-1'
        })).rejects.toThrow('403');

        expect(calls.filter((call) => call.url.includes('/members/principal-1'))).toHaveLength(0);
        expect(calls.filter((call) => call.url.includes('/sessions/session-1'))).toHaveLength(1);
    });

    it('surfaces joined-room presence policy failures without membership repair', async () => {
        const calls: FetchCall[] = [];
        stubFetch(calls, ({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/join')) {
                return jsonResponse(groupSnapshot('group-1'));
            }
            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                return new Response(
                    'Forbidden: group member is not active for presence session: principal-1',
                    { status: 403 }
                );
            }
            return jsonResponse(groupSnapshot('group-1'));
        });

        await expect(joinStateGroup({
            groupId: 'group-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1'
        })).rejects.toThrow('403');

        expect(calls.filter((call) => call.url.endsWith('/groups/group-1/join'))).toHaveLength(1);
        expect(calls.filter((call) => call.url.includes('/members/principal-1'))).toHaveLength(0);
    });

    it('does not retry or repair a repeated member-forbidden presence failure', async () => {
        const calls: FetchCall[] = [];
        stubFetch(calls, ({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                return jsonResponse(groupSnapshot('group-1'), 201);
            }
            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                return new Response(
                    'Forbidden: group member not found for presence session: principal-1',
                    { status: 403 }
                );
            }
            return jsonResponse(groupSnapshot('group-1'));
        });

        await expect(createAndJoinStateGroup({
            displayName: 'Room 1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            requestedGroupId: 'group-1'
        })).rejects.toThrow('403');

        expect(calls.filter((call) => call.url.includes('/sessions/session-1'))).toHaveLength(1);
        expect(calls.filter((call) => call.url.includes('/members/principal-1'))).toHaveLength(0);
    });
});

function stubFetch(
    calls: FetchCall[],
    respond: (call: FetchCall) => Response
): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const physicalUrl = String(input);
            const call = {
                url: physicalUrl.replace(/\/requests\/[A-Za-z0-9_-]+$/u, ''),
                method: init?.method ?? 'GET',
                body: init?.body ? JSON.parse(String(init.body)) : undefined
            };
            calls.push(call);
            return respond(call);
        })
    );
}

function jsonResponse(body: object, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

function groupSnapshot(groupId: string): GroupSnapshot {
    return createGroupSnapshotFixture({
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId,
        sessionIds: []
    });
}

function installEmptyLocalStorage(): void {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn()
    });
}
