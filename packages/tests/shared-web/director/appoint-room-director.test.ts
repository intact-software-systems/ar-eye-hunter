import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { appointStateGroupDirector } from '@shared-web/browser/director/appoint-room-director.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

describe('appoint room director workflow', () => {
    beforeEach(installEmptyLocalStorage);

    afterEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('owns request identity outside the appointment body', async () => {
        configureApiClient({ apiBaseUrl: '' });
        vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(
            'generated-appoint-request-id' as ReturnType<typeof crypto.randomUUID>
        );
        const requests: Array<{ url: string; body?: object; }> = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                requests.push({
                    url: String(input),
                    body: init?.body ? JSON.parse(String(init.body)) : undefined
                });
                return jsonResponse(groupSnapshot('group-1'));
            })
        );
        const requestWithCallerIdentity = {
            heartbeatTtlMs: 30_000,
            requestId: 'caller-supplied-body-id'
        } as Parameters<typeof appointStateGroupDirector>[0]['request'];

        await appointStateGroupDirector({
            groupId: 'group-1',
            request: requestWithCallerIdentity,
            principalId: 'owner-1',
            sessionId: 'owner-session'
        });

        expect(requests[0].url).toContain('/requests/generated-appoint-request-id');
        expect(requests[0].body).not.toHaveProperty('requestId');
    });
});

function jsonResponse(body: object): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function groupSnapshot(groupId: string): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId,
        sessionIds: []
    });
    const groupRevision = 3;
    return {
        ...snapshot,
        causalRevision: { ...snapshot.causalRevision, groupRevision },
        group: {
            ...snapshot.group,
            slug: groupId,
            joinMode: 'invite-only',
            snapshotVersion: groupRevision,
            metadataVersion: 1
        }
    };
}

function installEmptyLocalStorage(): void {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn()
    });
}
