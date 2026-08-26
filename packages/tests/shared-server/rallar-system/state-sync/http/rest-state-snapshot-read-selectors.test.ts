import { createClientRestSnapshotReadSelector } from '@shared-server/rallar-system/client-state/snapshot/client-rest-snapshot-read-selector.ts';
import { createClientStateSnapshotReadThroughCache } from '@shared-server/rallar-system/client-state/snapshot/client-state-snapshot-read-through-cache.ts';
import { createGroupRestSnapshotReadSelector } from '@shared-server/rallar-system/group-state/snapshot/group-rest-snapshot-read-selector.ts';
import { describe, expect, it, vi } from 'vitest';
import { configureTestCacheRepositories } from '../../../../cache-repository-config.ts';
import { createClientCache, createClientSnapshot, createGroupCache, createGroupSnapshot } from './rest-state-snapshot-read-test-fixtures.ts';

describe('client REST snapshot read selector', () => {
    it('uses one durable read for tokenless and strict reads even with eligible cache state', async () => {
        const cached = createClientSnapshot(5);
        const durableSnapshot = createClientSnapshot(6);
        const durable = { readSnapshot: vi.fn().mockResolvedValue(durableSnapshot) };
        const cache = createClientCache(cached);
        const selector = createClientRestSnapshotReadSelector({ durable, cache });

        await expect(selector.read(cached.principal)).resolves.toEqual({
            status: 'found',
            source: 'durable',
            snapshot: durableSnapshot
        });
        await expect(
            selector.read(cached.principal, {
                minStateRevision: 5,
                strictMode: true
            })
        ).resolves.toEqual({
            status: 'found',
            source: 'durable',
            snapshot: durableSnapshot
        });

        expect(durable.readSnapshot).toHaveBeenCalledTimes(2);
    });

    it('uses eligible scalar cache state without durable I/O', async () => {
        const cached = createClientSnapshot(5);
        const durable = { readSnapshot: vi.fn() };
        const selector = createClientRestSnapshotReadSelector({
            durable,
            cache: createClientCache(cached)
        });

        await expect(
            selector.read(cached.principal, { minStateRevision: 5 })
        ).resolves.toEqual({
            status: 'found',
            source: 'cache',
            snapshot: cached
        });
        expect(durable.readSnapshot).not.toHaveBeenCalled();
    });

    it('falls back once and returns a typed durable scalar shortfall', async () => {
        const cached = createClientSnapshot(2);
        const durableSnapshot = createClientSnapshot(3);
        const durable = { readSnapshot: vi.fn().mockResolvedValue(durableSnapshot) };
        const selector = createClientRestSnapshotReadSelector({
            durable,
            cache: createClientCache(cached)
        });

        await expect(
            selector.read(cached.principal, { minStateRevision: 4 })
        ).resolves.toEqual({
            status: 'floor-not-satisfied',
            source: 'durable',
            snapshot: durableSnapshot
        });
        expect(durable.readSnapshot).toHaveBeenCalledOnce();
    });

    it('keeps a newer observation when an older durable absence finishes', async () => {
        const observed = createClientSnapshot(1);
        const newer = createClientSnapshot(2);
        const cache = createClientCache(observed);
        const durable = {
            readSnapshot: vi.fn(async () => {
                cache.publish(newer);
                return undefined;
            })
        };
        const diagnostics = vi.fn();
        const now = vi.fn()
            .mockReturnValueOnce(10)
            .mockReturnValueOnce(17);
        const selector = createClientRestSnapshotReadSelector({
            durable,
            cache,
            diagnostics,
            now
        });

        await expect(selector.read(observed.principal)).resolves.toEqual({
            status: 'not-found',
            source: 'durable'
        });
        expect(cache.current()).toBe(newer);
        expect(diagnostics).toHaveBeenCalledWith({
            name: 'rallar.rest.client-state-snapshot-read',
            source: 'durable',
            result: 'not-found',
            floorOutcome: 'not-requested',
            cleanupOutcome: 'changed-or-absent',
            strictMode: false,
            durationMs: 7
        });
        expect(Object.keys(diagnostics.mock.calls[0]?.[0] ?? {})).not.toContain(
            'principalId'
        );
    });

    it('evicts matching loaned state without deleting a newer latest snapshot', async () => {
        configureTestCacheRepositories();
        const first = createClientSnapshot(1);
        const newer = createClientSnapshot(2);
        const cache = createClientStateSnapshotReadThroughCache({
            clientsRepository: {
                readSnapshot: vi.fn().mockResolvedValue(first)
            }
        });
        const loaded = await cache.findOrLoadByRef(first.principal);
        if (!loaded) {
            throw new Error('Expected loaded client snapshot');
        }

        expect(cache.observe(newer)).toBe('advanced');
        expect(cache.evictIfUnchanged(loaded.principal, loaded)).toBe(true);
        expect(cache.peek(newer.principal)).toBe(newer);

        expect(cache.evictIfUnchanged(newer.principal, newer)).toBe(true);
        expect(cache.peek(newer.principal)).toBeUndefined();
    });
});

describe('group REST snapshot read selector', () => {
    it.each(
        [
            ['equal', { groupRevision: 2, presenceRevision: 3 }],
            ['dominates', { groupRevision: 4, presenceRevision: 5 }]
        ] as const
    )('uses a cache tuple that %s the requested floor', async (_name, revision) => {
        const cached = createGroupSnapshot(revision.groupRevision, revision.presenceRevision);
        const durable = { readSnapshot: vi.fn() };
        const selector = createGroupRestSnapshotReadSelector({
            durable,
            cache: createGroupCache(cached)
        });

        await expect(
            selector.read(cached.group, {
                minCausalRevision: { groupRevision: 2, presenceRevision: 3 }
            })
        ).resolves.toEqual({
            status: 'found',
            source: 'cache',
            snapshot: cached
        });
        expect(durable.readSnapshot).not.toHaveBeenCalled();
    });

    it.each(
        [
            ['dominated', { groupRevision: 1, presenceRevision: 2 }],
            ['incomparable', { groupRevision: 4, presenceRevision: 2 }]
        ] as const
    )('falls back once when the cache tuple is %s', async (_name, revision) => {
        const cached = createGroupSnapshot(revision.groupRevision, revision.presenceRevision);
        const durableSnapshot = createGroupSnapshot(3, 3);
        const durable = { readSnapshot: vi.fn().mockResolvedValue(durableSnapshot) };
        const selector = createGroupRestSnapshotReadSelector({
            durable,
            cache: createGroupCache(cached)
        });

        await expect(
            selector.read(cached.group, {
                minCausalRevision: { groupRevision: 3, presenceRevision: 3 }
            })
        ).resolves.toEqual({
            status: 'found',
            source: 'durable',
            snapshot: durableSnapshot
        });
        expect(durable.readSnapshot).toHaveBeenCalledOnce();
    });

    it.each(
        [
            ['dominated', { groupRevision: 1, presenceRevision: 1 }],
            ['incomparable', { groupRevision: 4, presenceRevision: 1 }]
        ] as const
    )('returns a typed durable shortfall for a %s tuple', async (_name, revision) => {
        const durableSnapshot = createGroupSnapshot(
            revision.groupRevision,
            revision.presenceRevision
        );
        const durable = { readSnapshot: vi.fn().mockResolvedValue(durableSnapshot) };
        const selector = createGroupRestSnapshotReadSelector({
            durable,
            cache: createGroupCache()
        });

        await expect(
            selector.read(durableSnapshot.group, {
                minCausalRevision: { groupRevision: 3, presenceRevision: 3 }
            })
        ).resolves.toEqual({
            status: 'floor-not-satisfied',
            source: 'durable',
            snapshot: durableSnapshot
        });
        expect(durable.readSnapshot).toHaveBeenCalledOnce();
    });

    it('forces a strict tokened read through one durable snapshot', async () => {
        const cached = createGroupSnapshot(5, 5);
        const durableSnapshot = createGroupSnapshot(6, 6);
        const durable = { readSnapshot: vi.fn().mockResolvedValue(durableSnapshot) };
        const selector = createGroupRestSnapshotReadSelector({
            durable,
            cache: createGroupCache(cached)
        });

        await expect(
            selector.read(cached.group, {
                minCausalRevision: { groupRevision: 5, presenceRevision: 5 },
                strictMode: true
            })
        ).resolves.toMatchObject({
            status: 'found',
            source: 'durable',
            snapshot: durableSnapshot
        });
        expect(durable.readSnapshot).toHaveBeenCalledOnce();
    });

    it('keeps a newer group observation when durable absence loses the race', async () => {
        const observed = createGroupSnapshot(1, 1);
        const newer = createGroupSnapshot(2, 2);
        const cache = createGroupCache(observed);
        const durable = {
            readSnapshot: vi.fn(async () => {
                cache.publish(newer);
                return undefined;
            })
        };
        const diagnostics = vi.fn();
        const selector = createGroupRestSnapshotReadSelector({
            durable,
            cache,
            diagnostics,
            now: vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(9)
        });

        await expect(selector.read(observed.group)).resolves.toEqual({
            status: 'not-found',
            source: 'durable'
        });
        expect(cache.current()).toBe(newer);
        expect(diagnostics).toHaveBeenCalledWith({
            name: 'rallar.rest.group-state-snapshot-read',
            source: 'durable',
            result: 'not-found',
            floorOutcome: 'not-requested',
            cleanupOutcome: 'changed-or-absent',
            strictMode: false,
            durationMs: 5
        });
    });
});

describe('logical cache convergence', () => {
    it('makes an isolated third client and group cache fall back to one durable source', async () => {
        let durableClient = createClientSnapshot(1);
        let durableGroup = createGroupSnapshot(1, 1);
        const clientRead = vi.fn(async () => durableClient);
        const groupRead = vi.fn(async () => durableGroup);
        const clientCaches = [createClientCache(), createClientCache(), createClientCache()];
        const groupCaches = [createGroupCache(), createGroupCache(), createGroupCache()];
        const clientSelectors = clientCaches.map((cache) =>
            createClientRestSnapshotReadSelector({
                durable: { readSnapshot: clientRead },
                cache
            })
        );
        const groupSelectors = groupCaches.map((cache) =>
            createGroupRestSnapshotReadSelector({
                durable: { readSnapshot: groupRead },
                cache
            })
        );

        await Promise.all(clientSelectors.map((selector) => selector.read(durableClient.principal)));
        await Promise.all(groupSelectors.map((selector) => selector.read(durableGroup.group)));

        durableClient = createClientSnapshot(2);
        durableGroup = createGroupSnapshot(2, 2);
        clientCaches[0]?.publish(durableClient);
        clientCaches[1]?.publish(durableClient);
        groupCaches[0]?.publish(durableGroup);
        groupCaches[1]?.publish(durableGroup);

        await expect(
            clientSelectors[2]?.read(durableClient.principal, { minStateRevision: 2 })
        ).resolves.toMatchObject({ status: 'found', source: 'durable' });
        await expect(
            groupSelectors[2]?.read(durableGroup.group, {
                minCausalRevision: { groupRevision: 2, presenceRevision: 2 }
            })
        ).resolves.toMatchObject({ status: 'found', source: 'durable' });
        await expect(clientSelectors[2]?.read(durableClient.principal)).resolves.toMatchObject({
            status: 'found',
            source: 'durable'
        });
        await expect(groupSelectors[2]?.read(durableGroup.group)).resolves.toMatchObject({
            status: 'found',
            source: 'durable'
        });

        expect(clientRead).toHaveBeenCalledTimes(5);
        expect(groupRead).toHaveBeenCalledTimes(5);
    });
});
