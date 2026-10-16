import { describe, expect, it } from 'vitest';

import { VersionProbedReadThroughCache, type VersionProbedRead } from '@shared/cache/store-backed/version-probed-read-through-cache.ts';

interface StoredDocument {
    readonly version: string;
    readonly body: string;
    readonly validUntilEpochMs: number | null;
}

/** A versioned store that counts its cheap probes and its full reads; a full read reports its own version. */
function createStore(initial: StoredDocument | undefined) {
    let current = initial;
    const counts = { probes: 0, fullReads: 0 };
    return {
        counts,
        write(next: StoredDocument | undefined): void {
            current = next;
        },
        readVersion: async (_key: string): Promise<string | undefined> => {
            counts.probes += 1;
            return current?.version;
        },
        readValue: async (_key: string): Promise<VersionProbedRead<string> | undefined> => {
            counts.fullReads += 1;
            return current === undefined
                ? undefined
                : { value: current.body, version: current.version, validUntilEpochMs: current.validUntilEpochMs };
        }
    };
}

function createCache(
    store: Pick<ReturnType<typeof createStore>, 'readVersion' | 'readValue'>,
    nowEpochMs: () => number
) {
    return new VersionProbedReadThroughCache<string, string>({
        readVersion: store.readVersion,
        readValue: store.readValue,
        toCacheKey: (key) => key,
        nowEpochMs,
        maxEntries: 8
    });
}

describe('VersionProbedReadThroughCache', () => {
    it('reads a key it keeps nothing for once, and serves the unchanged value after from one probe', async () => {
        const store = createStore({ version: 'v1', body: 'first', validUntilEpochMs: null });
        const cache = createCache(store, () => 1_000);

        expect(await cache.read('doc')).toBe('first');
        expect(store.counts).toEqual({ probes: 0, fullReads: 1 });
        expect(await cache.read('doc')).toBe('first');
        expect(store.counts).toEqual({ probes: 1, fullReads: 1 });
    });

    it('reads the value again once a write moves the probed version', async () => {
        const store = createStore({ version: 'v1', body: 'first', validUntilEpochMs: null });
        const cache = createCache(store, () => 1_000);
        await cache.read('doc');

        store.write({ version: 'v2', body: 'second', validUntilEpochMs: null });

        expect(await cache.read('doc')).toBe('second');
        expect(store.counts).toEqual({ probes: 1, fullReads: 2 });
    });

    it('keeps a value under the version its own read reported, so a write landing after the probe is never served stale', async () => {
        const store = createStore({ version: 'v1', body: 'first', validUntilEpochMs: null });
        const cache = createCache(store, () => 1_000);
        await cache.read('doc');
        store.write({ version: 'v2', body: 'second', validUntilEpochMs: null });
        let racedOnce = false;
        // A third write lands between the probe and the full read.
        const racing = createCache({
            readVersion: store.readVersion,
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
            readVersion: unversioned.readVersion,
            readValue: async (key) => {
                const read = await unversioned.readValue(key);
                return read === undefined ? undefined : { ...read, version: null };
            }
        }, () => 1_000);
        expect(await unversionedCache.read('doc')).toBe('first');
        expect(await unversionedCache.read('doc')).toBe('first');
        expect(unversioned.counts.fullReads).toBe(2);
    });
});
