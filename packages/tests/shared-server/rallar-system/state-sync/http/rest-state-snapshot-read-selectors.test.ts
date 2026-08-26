import { createClientRestSnapshotReadSelector } from '@shared-server/rallar-system/client-state/snapshot/client-rest-snapshot-read-selector.ts';
import { createClientStateSnapshotReadThroughCache } from '@shared-server/rallar-system/client-state/snapshot/client-state-snapshot-read-through-cache.ts';
import { createGroupRestSnapshotReadSelector } from '@shared-server/rallar-system/group-state/snapshot/group-rest-snapshot-read-selector.ts';
import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateSnapshotReadDiagnosticEvent } from '@shared/api/state-snapshot-read.ts';
import { describe, expect, it } from 'vitest';
import { configureTestCacheRepositories } from '../../../../cache-repository-config.ts';
import { createClientCache, createClientSnapshot, createGroupCache, createGroupSnapshot } from './rest-state-snapshot-read-test-fixtures.ts';

describe('client REST snapshot read selector', () => {
    it('uses one durable read for tokenless and strict reads even with eligible cache state', async () => {
        const cached = createClientSnapshot(5);
        const durableSnapshot = createClientSnapshot(6);
        const durable = createClientDurableReader(cached.principal, [
            durableSnapshot,
            durableSnapshot
        ]);
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
    });

    it('uses eligible scalar cache state without durable I/O', async () => {
        const cached = createClientSnapshot(5);
        const durable = { readSnapshot: rejectUnexpectedClientDurableRead };
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
    });

    it('falls back once and returns a typed durable scalar shortfall', async () => {
        const cached = createClientSnapshot(2);
        const durableSnapshot = createClientSnapshot(3);
        const durable = createClientDurableReader(cached.principal, [durableSnapshot]);
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
    });

    it('keeps a newer observation when an older durable absence finishes', async () => {
        const observed = createClientSnapshot(1);
        const newer = createClientSnapshot(2);
        const cache = createClientCache(observed);
        const durable = {
            readSnapshot: async (ref: ClientPrincipalRef): Promise<undefined> => {
                expect(ref).toEqual(observed.principal);
                cache.publish(newer);
                return undefined;
            }
        };
        let diagnostic: StateSnapshotReadDiagnosticEvent | undefined;
        const selector = createClientRestSnapshotReadSelector({
            durable,
            cache,
            diagnostics: (event) => {
                diagnostic = event;
            },
            now: createSequentialClock([10, 17])
        });

        await expect(selector.read(observed.principal)).resolves.toEqual({
            status: 'not-found',
            source: 'durable'
        });
        expect(cache.current()).toBe(newer);
        expect(diagnostic).toEqual({
            name: 'rallar.rest.client-state-snapshot-read',
            source: 'durable',
            result: 'not-found',
            floorOutcome: 'not-requested',
            cleanupOutcome: 'changed-or-absent',
            strictMode: false,
            durationMs: 7
        });
        expect(diagnostic).not.toHaveProperty('principalId');
    });

    it('evicts matching loaned state without deleting a newer latest snapshot', async () => {
        configureTestCacheRepositories();
        const first = createClientSnapshot(1);
        const newer = createClientSnapshot(2);
        const cache = createClientStateSnapshotReadThroughCache({
            clientsRepository: {
                readSnapshot: async (ref): Promise<ClientSnapshot> => {
                    expect(ref).toEqual({
                        applicationId: first.principal.applicationId,
                        workspaceId: first.principal.workspaceId,
                        principalId: first.principal.principalId
                    });
                    return first;
                }
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
        const durable = { readSnapshot: rejectUnexpectedGroupDurableRead };
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
    });

    it.each(
        [
            ['dominated', { groupRevision: 1, presenceRevision: 2 }],
            ['incomparable', { groupRevision: 4, presenceRevision: 2 }]
        ] as const
    )('falls back once when the cache tuple is %s', async (_name, revision) => {
        const cached = createGroupSnapshot(revision.groupRevision, revision.presenceRevision);
        const durableSnapshot = createGroupSnapshot(3, 3);
        const durable = createGroupDurableReader(cached.group, [durableSnapshot]);
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
        const durable = createGroupDurableReader(durableSnapshot.group, [durableSnapshot]);
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
    });

    it('forces a strict tokened read through one durable snapshot', async () => {
        const cached = createGroupSnapshot(5, 5);
        const durableSnapshot = createGroupSnapshot(6, 6);
        const durable = createGroupDurableReader(cached.group, [durableSnapshot]);
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
    });

    it('keeps a newer group observation when durable absence loses the race', async () => {
        const observed = createGroupSnapshot(1, 1);
        const newer = createGroupSnapshot(2, 2);
        const cache = createGroupCache(observed);
        const durable = {
            readSnapshot: async (ref: GroupRef): Promise<undefined> => {
                expect(ref).toEqual(observed.group);
                cache.publish(newer);
                return undefined;
            }
        };
        let diagnostic: StateSnapshotReadDiagnosticEvent | undefined;
        const selector = createGroupRestSnapshotReadSelector({
            durable,
            cache,
            diagnostics: (event) => {
                diagnostic = event;
            },
            now: createSequentialClock([4, 9])
        });

        await expect(selector.read(observed.group)).resolves.toEqual({
            status: 'not-found',
            source: 'durable'
        });
        expect(cache.current()).toBe(newer);
        expect(diagnostic).toEqual({
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
        const clientRead = async (): Promise<ClientSnapshot> => durableClient;
        const groupRead = async (): Promise<GroupSnapshot> => durableGroup;
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
    });
});

function createClientDurableReader(
    expectedRef: ClientPrincipalRef,
    snapshots: readonly (ClientSnapshot | undefined)[]
): Readonly<{ readSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>; }> {
    let index = 0;
    return {
        readSnapshot: async (ref) => {
            expect(ref).toEqual(expectedRef);
            if (index >= snapshots.length) {
                throw new Error('Client snapshot selector performed an extra durable read');
            }
            return snapshots[index++];
        }
    };
}

function createGroupDurableReader(
    expectedRef: GroupRef,
    snapshots: readonly (GroupSnapshot | undefined)[]
): Readonly<{ readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>; }> {
    let index = 0;
    return {
        readSnapshot: async (ref) => {
            expect(ref).toEqual(expectedRef);
            if (index >= snapshots.length) {
                throw new Error('Group snapshot selector performed an extra durable read');
            }
            return snapshots[index++];
        }
    };
}

function rejectUnexpectedClientDurableRead(): Promise<never> {
    return Promise.reject(new Error('Eligible client cache state must avoid durable I/O'));
}

function rejectUnexpectedGroupDurableRead(): Promise<never> {
    return Promise.reject(new Error('Eligible group cache state must avoid durable I/O'));
}

function createSequentialClock(values: readonly number[]): () => number {
    let index = 0;
    return () => {
        const value = values[index++];
        if (value === undefined) {
            throw new Error('Snapshot selector read the clock more often than expected');
        }
        return value;
    };
}
