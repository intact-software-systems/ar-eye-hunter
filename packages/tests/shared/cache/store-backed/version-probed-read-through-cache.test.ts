import { describe, expect, it } from 'vitest';

import { VersionProbedReadThroughCache, type VersionProbedRead } from '@shared/cache/store-backed/version-probed-read-through-cache.ts';

interface StoredDocument {
    readonly version: string;
    readonly body: string;
    readonly validUntilEpochMs: number | null;
}

/**
 * A versioned store of documents by key that counts its batched probes, the keys they probe, and its full reads;
 * a full read reports its own version.
 */
function createDocumentStore(initial: ReadonlyMap<string, StoredDocument>) {
    const documents = new Map(initial);
    const counts = { probes: 0, probedKeys: 0, fullReads: 0 };
    const probedBatches: (readonly string[])[] = [];
    return {
        counts,
        probedBatches,
        write(key: string, next: StoredDocument | undefined): void {
            if (next === undefined) {
                documents.delete(key);
                return;
            }
            documents.set(key, next);
        },
        readVersions: async (keys: readonly string[]): Promise<readonly (string | undefined)[]> => {
            counts.probes += 1;
            counts.probedKeys += keys.length;
            probedBatches.push(keys);
            return keys.map((key) => documents.get(key)?.version);
        },
        readValue: async (key: string): Promise<VersionProbedRead<string> | undefined> => {
            counts.fullReads += 1;
            const current = documents.get(key);
            return current === undefined
                ? undefined
                : { value: current.body, version: current.version, validUntilEpochMs: current.validUntilEpochMs };
        }
    };
}

/** The single-document store the single-key cases use: every key reads the one document. */
function createStore(initial: StoredDocument | undefined) {
    const store = createDocumentStore(new Map(initial === undefined ? [] : [['doc', initial]]));
    return {
        counts: store.counts,
        write: (next: StoredDocument | undefined): void => store.write('doc', next),
        readVersions: store.readVersions,
        readValue: store.readValue
    };
}

function createCache(
    store: Pick<ReturnType<typeof createDocumentStore>, 'readVersions' | 'readValue'>,
    nowEpochMs: () => number,
    maxEntries = 8
) {
    return new VersionProbedReadThroughCache<string, string>({
        readVersions: store.readVersions,
        readValue: store.readValue,
        toCacheKey: (key) => key,
        nowEpochMs,
        maxEntries
    });
}

describe('VersionProbedReadThroughCache', () => {
    it('reads a key it keeps nothing for once, and serves the unchanged value after from one probe', async () => {
        const store = createStore({ version: 'v1', body: 'first', validUntilEpochMs: null });
        const cache = createCache(store, () => 1_000);

        expect(await cache.read('doc')).toBe('first');
        expect(store.counts).toEqual({ probes: 0, probedKeys: 0, fullReads: 1 });
        expect(await cache.read('doc')).toBe('first');
        expect(store.counts).toEqual({ probes: 1, probedKeys: 1, fullReads: 1 });
    });

    it('reads the value again once a write moves the probed version', async () => {
        const store = createStore({ version: 'v1', body: 'first', validUntilEpochMs: null });
        const cache = createCache(store, () => 1_000);
        await cache.read('doc');

        store.write({ version: 'v2', body: 'second', validUntilEpochMs: null });

        expect(await cache.read('doc')).toBe('second');
        expect(store.counts).toEqual({ probes: 1, probedKeys: 1, fullReads: 2 });
    });

    it('keeps a value under the version its own read reported, so a write landing after the probe is never served stale', async () => {
        const store = createStore({ version: 'v1', body: 'first', validUntilEpochMs: null });
        const cache = createCache(store, () => 1_000);
        await cache.read('doc');
        store.write({ version: 'v2', body: 'second', validUntilEpochMs: null });
        let racedOnce = false;
        // A third write lands between the probe and the full read.
        const racing = createCache({
            readVersions: store.readVersions,
            readValue: async (key) => {
                if (!racedOnce) {
                    racedOnce = true;
                    store.write({ version: 'v3', body: 'third', validUntilEpochMs: null });
                }
                return await store.readValue(key);
            }
        }, () => 1_000);
        await racing.read('doc');

        expect(await racing.read('doc')).toBe('third');
        expect(await racing.read('doc')).toBe('third');
        expect(await cache.read('doc')).toBe('third');
    });

    it('reads again once the value passes the instant it stays valid until', async () => {
        let nowEpochMs = 1_000;
        const store = createStore({ version: 'v1', body: 'first', validUntilEpochMs: 1_500 });
        const cache = createCache(store, () => nowEpochMs);
        await cache.read('doc');
        await cache.read('doc');

        nowEpochMs = 1_500;
        await cache.read('doc');

        expect(store.counts.fullReads).toBe(2);
    });

    it('keeps neither an absent value nor one whose read named no version', async () => {
        const absent = createStore(undefined);
        const absentCache = createCache(absent, () => 1_000);
        expect(await absentCache.read('doc')).toBeUndefined();
        expect(await absentCache.read('doc')).toBeUndefined();
        expect(absent.counts.fullReads).toBe(2);

        const unversioned = createStore({ version: 'v1', body: 'first', validUntilEpochMs: null });
        const unversionedCache = createCache({
            readVersions: unversioned.readVersions,
            readValue: async (key) => {
                const read = await unversioned.readValue(key);
                return read === undefined ? undefined : { ...read, version: null };
            }
        }, () => 1_000);
        expect(await unversionedCache.read('doc')).toBe('first');
        expect(await unversionedCache.read('doc')).toBe('first');
        expect(unversioned.counts.fullReads).toBe(2);
    });

    describe('readMany', () => {
        const KEYS = Array.from({ length: 21 }, (_, index) => `group-${index}`);

        function createKeptStore() {
            return createDocumentStore(
                new Map(KEYS.map((key) => [key, { version: `${key}@1`, body: `${key} first`, validUntilEpochMs: null }]))
            );
        }

        it('serves every unchanged kept key from one batched probe and in the order asked', async () => {
            const store = createKeptStore();
            const cache = createCache(store, () => 1_000, 32);
            await cache.readMany(KEYS);
            store.counts.fullReads = 0;

            const values = await cache.readMany(KEYS);

            expect(values).toEqual(KEYS.map((key) => `${key} first`));
            expect(store.counts).toEqual({ probes: 1, probedKeys: 21, fullReads: 0 });
        });

        it('reads only a changed key again, after the one batched probe', async () => {
            const store = createKeptStore();
            const cache = createCache(store, () => 1_000, 32);
            await cache.readMany(KEYS);
            store.write('group-7', { version: 'group-7@2', body: 'group-7 second', validUntilEpochMs: null });
            store.counts.fullReads = 0;
            store.counts.probes = 0;

            const values = await cache.readMany(KEYS);

            expect(values[7]).toBe('group-7 second');
            expect(values.filter((value, index) => index !== 7)).toEqual(
                KEYS.filter((_, index) => index !== 7).map((key) => `${key} first`)
            );
            expect(store.counts).toMatchObject({ probes: 1, fullReads: 1 });
        });

        it('probes only the keys it keeps a live value for and never probes when it keeps none', async () => {
            let nowEpochMs = 1_000;
            const store = createDocumentStore(
                new Map([
                    ['kept', { version: 'kept@1', body: 'kept', validUntilEpochMs: null }],
                    ['expiring', { version: 'expiring@1', body: 'expiring', validUntilEpochMs: 1_500 }]
                ])
            );
            const cache = createCache(store, () => nowEpochMs, 32);

            expect(await cache.readMany(['kept', 'expiring', 'absent'])).toEqual(['kept', 'expiring', undefined]);
            expect(store.counts).toEqual({ probes: 0, probedKeys: 0, fullReads: 3 });

            nowEpochMs = 1_500;
            expect(await cache.readMany(['kept', 'expiring', 'absent'])).toEqual(['kept', 'expiring', undefined]);
            expect(store.probedBatches).toEqual([['kept']]);
            expect(store.counts.fullReads).toBe(5);
        });

        it('lets a probe failure reach the caller and reads fresh once the store recovers', async () => {
            const store = createKeptStore();
            const failure = new Error('version reader unavailable');
            let failing = false;
            const cache = createCache(
                {
                    readVersions: async (keys) => {
                        if (failing) {
                            throw failure;
                        }
                        return await store.readVersions(keys);
                    },
                    readValue: store.readValue
                },
                () => 1_000,
                32
            );
            await cache.readMany(KEYS);

            failing = true;
            await expect(cache.readMany(KEYS)).rejects.toBe(failure);
            failing = false;
            store.write('group-0', { version: 'group-0@2', body: 'group-0 second', validUntilEpochMs: null });

            expect((await cache.readMany(KEYS))[0]).toBe('group-0 second');
        });

        it('keeps a value under the version its own read reported when a write lands after the batched probe', async () => {
            const store = createKeptStore();
            let racing = false;
            const cache = createCache(
                {
                    readVersions: store.readVersions,
                    readValue: async (key) => {
                        if (racing && key === 'group-3') {
                            racing = false;
                            store.write(key, { version: 'group-3@3', body: 'group-3 third', validUntilEpochMs: null });
                        }
                        return await store.readValue(key);
                    }
                },
                () => 1_000,
                32
            );
            await cache.readMany(KEYS);
            store.write('group-3', { version: 'group-3@2', body: 'group-3 second', validUntilEpochMs: null });
            racing = true;

            expect((await cache.readMany(KEYS))[3]).toBe('group-3 third');
            store.counts.fullReads = 0;
            expect((await cache.readMany(KEYS))[3]).toBe('group-3 third');
            expect(store.counts.fullReads).toBe(0);
        });
    });
});
