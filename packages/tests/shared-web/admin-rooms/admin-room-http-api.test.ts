import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import {
    pruneAdminExpiredRecords,
    readAdminRoomDirectory,
    readAdminRoomExplanation,
    readAdminRoomTopologyWork,
    recomputeAdminRoomTopology
} from '@shared-web/browser/admin-rooms/admin-room-http-api.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';

const scope = { applicationId: 'ar-eye-hunter', workspaceId: 'test:rooms' };
const session = { clientId: 'admin', username: 'operator', sessionId: 'admin-session', accessToken: 'test-only', expiresAtEpochMs: 30_000 };
const response = { scope, observedAtEpochMs: 10_000, completeness: 'complete', entries: [], nextAfterGroupId: 'b-room' };

afterEach(() => vi.unstubAllGlobals());

it('sends the explicit API identity, encoded scope and cursor, and decodes the bounded response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await expect(readAdminRoomDirectory({
        apiBaseUrl: 'https://api.example.test/',
        scope,
        limit: 20,
        afterGroupId: 'a:room',
        session,
        signal
    })).resolves.toEqual(response);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/admin/operations/rooms/apps/ar-eye-hunter/workspaces/test%3Arooms?limit=20&afterGroupId=a%3Aroom');
    expect(options?.method).toBe('GET');
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-only');
    expect(new Headers(options?.headers).get('x-client-id')).toBe('admin');
    expect(options?.signal).toBe(signal);
});

it('preserves authorization failures and never substitutes stored credentials for a missing API session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ error: 'Forbidden' }, { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(readAdminRoomDirectory({
        apiBaseUrl: 'https://api.example.test',
        scope,
        limit: 20,
        afterGroupId: null,
        session: null,
        signal: new AbortController().signal
    })).rejects.toBeInstanceOf(ApiHttpError);
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-client-id')).toBe(false);
});

it('rejects a response from another workspace instead of presenting its rooms', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
            ...response,
            scope: { ...scope, workspaceId: 'foreign' }
        }))
    );
    await expect(readAdminRoomDirectory({
        apiBaseUrl: 'https://api.example.test',
        scope,
        limit: 20,
        afterGroupId: null,
        session,
        signal: new AbortController().signal
    })).rejects.toThrow('foreign scope');
});

it('reads the existing group explanation with explicit API authentication and exact room identity', async () => {
    const roomRef = { ...scope, groupId: 'private-room' };
    const explanation = {
        target: { kind: 'group', groupRef: roomRef },
        generatedAtEpochMs: 10_000,
        facts: [],
        timeline: [],
        warnings: [],
        likelyCauses: [],
        suggestedActions: [],
        rawRefs: []
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(explanation));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await expect(readAdminRoomExplanation({ apiBaseUrl: 'https://api.example.test', roomRef, session, signal }))
        .resolves.toEqual(explanation);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/admin/support/explain/group');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({ groupRef: roomRef, limitRecentEvents: 20 });
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-only');
    expect(options?.signal).toBe(signal);

    fetch.mockResolvedValue(Response.json({ ...explanation, target: { kind: 'group', groupRef: { ...roomRef, groupId: 'other' } } }));
    await expect(readAdminRoomExplanation({ apiBaseUrl: 'https://api.example.test', roomRef, session, signal }))
        .rejects.toThrow('foreign room');
});

it('reads exact topology work with explicit authority and rejects another receipt outcome', async () => {
    const request = { roomRef: { ...scope, groupId: 'private-room' }, outboxId: 'request-1:rtc-topology-recompute:explicit' };
    const result = { ...request, observedAtEpochMs: 10_000, status: 'completed', attempts: 1, settledAtEpochMs: 9_999 };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(result));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const input = { ...request, apiBaseUrl: 'https://api.example.test', session, signal };
    await expect(readAdminRoomTopologyWork(input)).resolves.toEqual(result);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(
        'https://api.example.test/api/admin/operations/rooms/apps/ar-eye-hunter/workspaces/test%3Arooms/groups/private-room/topology-work/request-1%3Artc-topology-recompute%3Aexplicit'
    );
    expect(options?.method).toBe('GET');
    expect(options?.signal).toBe(signal);
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-only');
    fetch.mockResolvedValue(Response.json({ ...result, outboxId: 'another-command' }));
    await expect(readAdminRoomTopologyWork(input)).rejects.toThrow('another room or receipt');
});

it('queues exact room topology with the original command ID and refuses a foreign receipt', async () => {
    const roomRef = { ...scope, groupId: 'private-room' };
    const receipt = { status: 'queued', groupRef: roomRef, requestId: 'recovery-1', outboxId: 'outbox-1' };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(receipt));
    vi.stubGlobal('fetch', fetch);
    const input = { apiBaseUrl: 'https://api.example.test', roomRef, requestId: 'recovery-1', session, signal: new AbortController().signal };
    await expect(recomputeAdminRoomTopology(input)).resolves.toEqual(receipt);
    expect(fetch).toHaveBeenCalledWith(
        'https://api.example.test/api/admin/operations/topology/recompute/requests/recovery-1',
        expect.objectContaining({ body: JSON.stringify({ groupRef: roomRef, publish: true }) })
    );
    fetch.mockResolvedValue(Response.json({ ...receipt, requestId: 'another-command' }));
    await expect(recomputeAdminRoomTopology(input)).rejects.toThrow('another room or command');
    fetch.mockResolvedValue(Response.json({ ...receipt, groupRef: { ...roomRef, workspaceId: 'foreign' } }));
    await expect(recomputeAdminRoomTopology(input)).rejects.toThrow('another room or command');
});

it('binds global maintenance to explicit categories and preview or execution intent', async () => {
    const result = {
        generatedAtEpochMs: 10_000,
        serverId: 'api-1',
        warnings: [],
        operation: 'maintenance.prune-expired',
        status: 'dry-run',
        changed: false,
        jobId: 'job-1',
        results: [{ category: 'runtime-state', expiredRows: 3, deletedRows: 0, dryRun: true }]
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(result));
    vi.stubGlobal('fetch', fetch);
    const input = {
        apiBaseUrl: 'https://api.example.test',
        requestId: 'preview-1',
        categories: ['runtime-state'] as const,
        dryRun: true,
        session,
        signal: new AbortController().signal
    };
    await expect(pruneAdminExpiredRecords(input)).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledWith(
        'https://api.example.test/api/admin/operations/maintenance/prune-expired/requests/preview-1',
        expect.objectContaining({ body: JSON.stringify({ categories: ['runtime-state'], dryRun: true }) })
    );
    await expect(pruneAdminExpiredRecords({ ...input, dryRun: false })).rejects.toThrow('maintenance intent');
    await expect(pruneAdminExpiredRecords({ ...input, categories: ['resource-inbox'] })).rejects.toThrow('maintenance intent');
    fetch.mockResolvedValue(
        Response.json({
            ...result,
            status: 'completed',
            changed: true,
            results: [{ category: 'runtime-state', expiredRows: 3, deletedRows: 3, dryRun: false }]
        })
    );
    await expect(pruneAdminExpiredRecords({ ...input, requestId: 'execute-1', dryRun: false })).resolves.toMatchObject({ status: 'completed', changed: true });
});
