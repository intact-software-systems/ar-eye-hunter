import { afterEach, expect, it, vi } from 'vitest';

import { AdminRoomOperations } from '@shared-web/browser/admin-rooms/admin-room-operations.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

const scope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };
const roomRef = { ...scope, groupId: 'room-1' };
const directory = { scope, observedAtEpochMs: 1_000, completeness: 'complete', entries: [], nextAfterGroupId: null };
const explanation = {
    target: { kind: 'group', groupRef: roomRef },
    generatedAtEpochMs: 1_000,
    facts: [],
    timeline: [],
    warnings: [],
    likelyCauses: [],
    suggestedActions: [],
    rawRefs: []
};
const admin: AuthSession = { clientId: 'admin', username: 'admin', sessionId: 'admin-session', accessToken: 'test-only', expiresAtEpochMs: 9999999999999 };
const cleanups: (() => void)[] = [];

afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.unstubAllGlobals();
});

it('loads the bounded directory and selected explanation under the same API session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => Response.json(String(url).includes('/explain/') ? explanation : directory));
    vi.stubGlobal('fetch', fetch);
    const test = inspection();
    await test.owner.start();
    expect(test.owner.getState().view).toMatchObject({ directory, explanation });
    for (const [, options] of fetch.mock.calls) {
        expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-only');
    }
});

it('clears all private evidence when either read refuses the operator, then recovers on a fresh refresh', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => Response.json(String(url).includes('/explain/') ? explanation : directory));
    vi.stubGlobal('fetch', fetch);
    const test = inspection();
    await test.owner.start();
    expect(test.owner.getState().view?.explanation).toEqual(explanation);
    fetch.mockImplementation(async (url) =>
        String(url).includes('/explain/')
            ? Response.json({ error: 'Forbidden' }, { status: 403 })
            : Response.json(directory)
    );
    await test.owner.refresh();
    expect(test.owner.getState().view).toBeNull();
    expect(test.owner.getState().error).toContain('403');
    fetch.mockImplementation(async (url) => Response.json(String(url).includes('/explain/') ? explanation : directory));
    await test.owner.refresh();
    expect(test.owner.getState()).toMatchObject({ view: { directory, explanation }, error: null });
});

it('aborts and discards late account evidence after logout and late selection evidence after stop', async () => {
    const late = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
        started.resolve();
        return late.promise;
    });
    vi.stubGlobal('fetch', fetch);
    const test = inspection(null);
    const start = test.owner.start();
    await started.promise;
    test.login(undefined);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    late.resolve(Response.json(directory));
    await start;
    expect(test.owner.getState().view).toBeNull();

    fetch.mockImplementation(async () => Response.json(directory));
    test.login(admin);
    await test.owner.refresh();
    expect(test.owner.getState().view?.directory).toEqual(directory);
    const obsolete = Promise.withResolvers<Response>();
    const refreshStarted = Promise.withResolvers<void>();
    fetch.mockImplementation(() => {
        refreshStarted.resolve();
        return obsolete.promise;
    });
    const refresh = test.owner.refresh();
    await refreshStarted.promise;
    test.owner.stop();
    expect(fetch.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    obsolete.resolve(Response.json(directory));
    await refresh;
    expect(test.owner.getState().view).toBeNull();
});

interface InspectionFixture {
    readonly owner: AdminRoomOperations;
    login(next: AuthSession | undefined): void;
}

function inspection(selectedGroupId: string | null = roomRef.groupId): InspectionFixture {
    let session: AuthSession | undefined = admin;
    const changes = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    const owner = new AdminRoomOperations({
        auth: { session: () => session, onChange: (listener) => changes.subscribe(listener).unsubscribe },
        activity: { isActive: () => true, onChange: () => () => {} },
        timers: createDefaultTimers(),
        createId: () => crypto.randomUUID()
    }, { scope, apiBaseUrl: 'https://api.example.test', afterGroupId: null, selectedGroupId, refreshIntervalMs: 30_000 });
    cleanups.push(() => owner.stop());
    return {
        owner,
        login(next: AuthSession | undefined) {
            session = next;
            changes.publishLatest({ authenticated: next !== undefined, reason: next ? 'login' : 'logout', session: next });
        }
    };
}

it('keeps a queued topology receipt distinct from completion and rereads room evidence after settlement', async () => {
    let settled = false;
    let settledEvidenceRead = false;
    vi.stubGlobal(
        'fetch',
        vi.fn<typeof globalThis.fetch>(async (url, options) => {
            const path = String(url);
            if (path.includes('/recompute/')) {
                return Response.json({ status: 'queued', groupRef: roomRef, requestId: path.split('/').at(-1), outboxId: 'work-1' });
            }
            if (path.includes('/topology-work/')) {
                return Response.json({
                    roomRef,
                    outboxId: 'work-1',
                    observedAtEpochMs: 2_000,
                    status: settled ? 'completed' : 'pending',
                    attempts: 1,
                    settledAtEpochMs: settled ? 1_999 : null
                });
            }
            if (path.includes('/explain/')) {
                settledEvidenceRead = settled;
                return Response.json(explanation);
            }
            return Response.json(directory);
        })
    );
    const test = inspection();
    await test.owner.start();
    await test.owner.act({ kind: 'recompute' });
    expect(test.owner.getState().view?.topology?.work.status).toBe('pending');
    expect(test.owner.getState().retryPending).toBe(false);
    settled = true;
    await test.owner.refresh();
    expect(test.owner.getState().view?.topology?.work.status).toBe('completed');
    expect(settledEvidenceRead).toBe(true);
    test.login(undefined);
    test.login(admin);
    await test.owner.refresh();
    expect(test.owner.getState().view?.topology).toBeNull();
});

it('retries a lost recovery response with the same command identity and no replacement command', async () => {
    const attemptedIds: string[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn<typeof globalThis.fetch>(async (url) => {
            const path = String(url);
            if (path.includes('/recompute/')) {
                const requestId = path.split('/').at(-1)!;
                attemptedIds.push(requestId);
                if (attemptedIds.length === 1) {
                    throw new Error('Response lost after commit');
                }
                return Response.json({ status: 'queued', groupRef: roomRef, requestId, outboxId: 'work-1' });
            }
            if (path.includes('/topology-work/')) {
                return Response.json({ roomRef, outboxId: 'work-1', observedAtEpochMs: 2_000, status: 'unknown', attempts: null, settledAtEpochMs: null });
            }
            return Response.json(path.includes('/explain/') ? explanation : directory);
        })
    );
    const test = inspection();
    await test.owner.start();
    await test.owner.act({ kind: 'recompute' });
    expect(test.owner.getState().retryPending).toBe(true);
    const originalId = attemptedIds[0];
    await test.owner.act({ kind: 'recompute' });
    await test.owner.retry();
    expect(new Set(attemptedIds)).toEqual(new Set([originalId]));
    expect(test.owner.getState()).toMatchObject({ retryPending: false, view: { topology: { work: { status: 'unknown' } } } });
});

interface MaintenanceEffect {
    readonly categories: string[];
    readonly dryRun: boolean;
}

it('requires the current successful global preview before execution and preserves its category scope', async () => {
    const effects: MaintenanceEffect[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn<typeof globalThis.fetch>(async (url, options) => {
            const path = String(url);
            if (path.includes('/prune-expired/')) {
                const body = JSON.parse(String(options?.body));
                effects.push(body);
                return Response.json({
                    generatedAtEpochMs: 2_000,
                    serverId: 'api',
                    warnings: [],
                    operation: 'maintenance.prune-expired',
                    status: body.dryRun ? 'dry-run' : 'completed',
                    changed: !body.dryRun,
                    jobId: path.split('/').at(-1),
                    results: body.categories.map((category: string) => ({ category, expiredRows: 2, deletedRows: body.dryRun ? 0 : 2, dryRun: body.dryRun }))
                });
            }
            return Response.json(path.includes('/explain/') ? explanation : directory);
        })
    );
    const test = inspection();
    await test.owner.start();
    await test.owner.act({ kind: 'execute-maintenance', previewRequestId: 'absent' });
    expect(test.owner.getState().error).toContain('preview');
    await test.owner.act({ kind: 'preview-maintenance', categories: ['runtime-state'] });
    const preview = test.owner.getState().view!.maintenance!;
    expect(preview.result.status).toBe('dry-run');
    await test.owner.act({ kind: 'execute-maintenance', previewRequestId: preview.requestId });
    expect(test.owner.getState().view?.maintenance?.result.status).toBe('completed');
    expect(effects).toEqual([{ categories: ['runtime-state'], dryRun: true }, { categories: ['runtime-state'], dryRun: false }]);
    await test.owner.act({ kind: 'execute-maintenance', previewRequestId: preview.requestId });
    expect(test.owner.getState().error).toContain('preview');
});
