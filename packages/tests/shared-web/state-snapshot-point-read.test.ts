import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { setBrowserStateReadDiagnosticsSink, type BrowserStateReadDiagnosticEvent } from '@shared-web/browser/state-read/diagnostics.ts';
import { readStateClientSnapshot, readStateGroupSnapshot } from '@shared-web/browser/state-read/point-read.ts';
import { findStateGroup } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';

import { createClientSnapshotFixture, createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('browser state snapshot point reads', () => {
    beforeEach(() => {
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setBrowserStateReadDiagnosticsSink(undefined);
    });

    it('returns client metadata and sends one canonical scalar floor', async () => {
        const snapshot = createClientSnapshotFixture({ ...scope, principalId: 'alice' });
        const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
            jsonSnapshotResponse(snapshot, {
                'rallar-state-source': 'cache',
                'rallar-state-revision': '1'
            })
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(readStateClientSnapshot('alice', scope, {
            authSession: null,
            minStateRevision: 1
        })).resolves
            .toEqual({ snapshot, source: 'cache', stateRevision: 1 });
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/clients/alice?minStateRevision=1'
        );
    });

    it('returns group causal metadata while preserving the body-only wrapper', async () => {
        const snapshot = createGroupSnapshotFixture({ ...scope, groupId: 'room-1', sessionIds: [] });
        const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
            jsonSnapshotResponse(snapshot, {
                'rallar-state-source': 'durable',
                'rallar-group-revision': '1',
                'rallar-presence-revision': '0'
            })
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(readStateGroupSnapshot('room-1', scope, {
            authSession: null,
            minCausalRevision: { groupRevision: 1, presenceRevision: 0 }
        })).resolves.toEqual({
            snapshot,
            source: 'durable',
            groupRevision: 1,
            presenceRevision: 0
        });
        await expect(findStateGroup('room-1', scope, { authSession: null })).resolves.toEqual(snapshot);
        expect(fetchMock.mock.calls[0]?.[0]).toContain(
            '?minGroupRevision=1&minPresenceRevision=0'
        );
        expect(fetchMock.mock.calls[1]?.[0]).not.toContain('?');
    });

    it('rejects malformed authoritative bodies and header/body disagreement', async () => {
        const snapshot = createGroupSnapshotFixture({ ...scope, groupId: 'room-1', sessionIds: [] });
        vi.stubGlobal(
            'fetch',
            vi.fn()
                .mockResolvedValueOnce(jsonSnapshotResponse({ ...snapshot, members: null }, {
                    'rallar-state-source': 'durable',
                    'rallar-group-revision': '1',
                    'rallar-presence-revision': '0'
                }))
                .mockResolvedValueOnce(jsonSnapshotResponse(snapshot, {
                    'rallar-state-source': 'durable',
                    'rallar-group-revision': '2',
                    'rallar-presence-revision': '0'
                }))
        );

        await expect(readStateGroupSnapshot('room-1', scope, { authSession: null })).rejects.toThrow();
        await expect(readStateGroupSnapshot('room-1', scope, { authSession: null })).rejects.toThrow(
            'header revisions do not match the body'
        );
    });

    it('emits only bounded diagnostics dimensions', async () => {
        const events: BrowserStateReadDiagnosticEvent[] = [];
        const snapshot = createClientSnapshotFixture({ ...scope, principalId: 'alice' });
        setBrowserStateReadDiagnosticsSink((event) => events.push(event));
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                jsonSnapshotResponse(snapshot, {
                    'rallar-state-source': 'durable',
                    'rallar-state-revision': '1'
                })
            )
        );

        await readStateClientSnapshot('alice', scope, { authSession: null });

        expect(events).toHaveLength(1);
        expect(Object.keys(events[0] ?? {}).sort()).toEqual([
            'durationMs',
            'feature',
            'name',
            'operation',
            'result',
            'source'
        ]);
        expect(JSON.stringify(events[0])).not.toContain('alice');
        expect(JSON.stringify(events[0])).not.toContain('app-1');
    });
});

function jsonSnapshotResponse(
    body: unknown,
    headers: Readonly<Record<string, string>>
): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
    });
}
