import { describe, expect, it } from 'vitest';

import { VersionProbedReadThroughCache } from '@shared/cache/version-probed-read-through-cache.ts';

interface StoredDocument {
    readonly version: string;
    readonly body: string;
    readonly validUntilEpochMs: number | null;
}

/** A versioned store that counts its cheap probes and its full reads. */
function createStore(initial: StoredDocument | undefined) {
    let current = initial;
    const counts = { probes: 0, fullReads: 0 };
    return {
        counts,
        write(next: StoredDocument | undefined): void {
            current = next;
        },
        readVersion: async (_key: string) => {
            counts.probes += 1;
            return current === undefined ? undefined : { version: current.version, validUntilEpochMs: null };
        },
        readValue: async (_key: string) => {
            counts.fullReads += 1;
            return current === undefined
                ? undefined
                : { value: current.body, validUntilEpochMs: current.validUntilEpochMs };
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
    it('serves a second read of an unchanged version from one probe and no full read', async () => {
        const store = createStore({ version: 'v1', body: 'first', validUntilEpochMs: null });
        const cache = createCache(store, () => 1_000);

        expect(await cache.read('doc')).toBe('first');
        expect(await cache.read('doc')).toBe('first');

        // The first read probes, reads and confirms; the second only probes.
        expect(store.counts).toEqual({ probes: 3, fullReads: 1 });
    });

    it('reads the value again once a write moves the probed version', async () => {
        const store = createStore({ version: 'v1', body: 'first', validUntilEpochMs: null });
        const cache = createCache(store, () => 1_000);
        await cache.read('doc');

        store.write({ version: 'v2', body: 'second', validUntilEpochMs: null });

        expect(await cache.read('doc')).toBe('second');
        expect(store.counts.fullReads).toBe(2);
    });

    it('keeps no full read that a write overtook before the confirming probe', async () => {
        const store = createStore({ version: 'v1', body: 'first', validUntilEpochMs: null });
        let racedOnce = false;
        // A write lands between the probe and the full read: the read sees v2 under a v1 probe.
        const cache = createCache({
            readVersion: store.readVersion,
            readValue: async (key) => {
                if (!racedOnce) {
                    racedOnce = true;
                    store.write({ version: 'v2', body: 'second', validUntilEpochMs: null });
                }
                return await store.readValue(key);
            }
        }, () => 1_000);

        expect(await cache.read('doc')).toBe('second');
        expect(await cache.read('doc')).toBe('second');
        expect(await cache.read('doc')).toBe('second');

        expect(store.counts.fullReads).toBe(2);
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

    it('caches no absent value', async () => {
        const store = createStore(undefined);
        const cache = createCache(store, () => 1_000);

        expect(await cache.read('doc')).toBeUndefined();
        expect(await cache.read('doc')).toBeUndefined();
        expect(store.counts.fullReads).toBe(2);
    });
});
