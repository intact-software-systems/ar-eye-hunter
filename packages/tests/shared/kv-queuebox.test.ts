import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';

(globalThis as { Temporal?: typeof Temporal }).Temporal ??= Temporal;

let currentKv = createFakeKv();
const kvQueueBoxModulePath = [
    '..',
    '..',
    '..',
    'apps',
    'api-v1',
    'src',
    'queuebox',
    'KVQueueBox.ts',
].join('/');

vi.mock('../../../apps/api-v1/src/db/kv.ts', () => ({
    getKv: async () => currentKv,
}));

describe('KVQueueBox', () => {
    beforeEach(() => {
        vi.resetModules();
        currentKv = createFakeKv();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('lazy-evicts expired entries from reads and key listing', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const { KVQueueBox } = await import(kvQueueBoxModulePath);
        const queue = new KVQueueBox();
        const expired = createEntry('expired-1', {
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
        });
        const active = createEntry('active-1');

        await queue.enqueue(expired);
        await queue.enqueue(active);

        expect(await queue.getItem(expired.key)).toBeUndefined();
        expect(await queue.getAllKeys()).toEqual([active.key]);
        expect(currentKv.size()).toBe(1);
    });

    it('treats expired entries as absent work in enqueueIfAbsent', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const { KVQueueBox } = await import(kvQueueBoxModulePath);
        const queue = new KVQueueBox();
        const key = {
            topicId: 'presence.state.v1',
            resourceId: 'resource-1',
            contextId: 'ctx-1',
        };

        await queue.enqueueIfAbsent({
            ...createEntry('resource-1', {
                expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
            }),
            key,
            resource: JSON.stringify({ text: 'stale' }),
        });

        const replacement = {
            ...createEntry('resource-1'),
            key,
            resource: JSON.stringify({ text: 'fresh' }),
        };

        const stored = await queue.enqueueIfAbsent(replacement);

        expect(JSON.parse(stored.resource)).toEqual({ text: 'fresh' });
        expect(await queue.getItem(key)).toEqual(replacement);
    });
});

function createFakeKv() {
    let versionCounter = 0;
    const entries = new Map<string, StoredKvEntry>();

    return {
        async set(key: readonly unknown[], value: ResourceEntry) {
            entries.set(keyToString(key), {
                key: [...key],
                value,
                versionstamp: String(++versionCounter),
            });
        },
        async delete(key: readonly unknown[]) {
            entries.delete(keyToString(key));
        },
        list({ prefix }: { prefix: readonly unknown[] }, options?: { limit?: number }) {
            const matching = [...entries.values()]
                .filter((entry) => hasPrefix(entry.key, prefix))
                .slice(0, options?.limit ?? Number.MAX_SAFE_INTEGER);

            let index = 0;

            return {
                [Symbol.asyncIterator]() {
                    return this;
                },
                async next() {
                    const value = matching[index];
                    index += 1;

                    if (!value) {
                        return {
                            done: true,
                            value: undefined,
                        };
                    }

                    return {
                        done: false,
                        value,
                    };
                },
            };
        },
        atomic() {
            let checkKey: readonly unknown[] | undefined;
            let checkVersionstamp: string | null | undefined;
            let deleteKey: readonly unknown[] | undefined;

            return {
                check(input: { key: readonly unknown[]; versionstamp: string | null }) {
                    checkKey = input.key;
                    checkVersionstamp = input.versionstamp;
                    return this;
                },
                delete(key: readonly unknown[]) {
                    deleteKey = key;
                    return this;
                },
                async commit() {
                    if (checkKey) {
                        const stored = entries.get(keyToString(checkKey));
                        const currentVersionstamp = stored?.versionstamp ?? null;
                        if (currentVersionstamp !== checkVersionstamp) {
                            return { ok: false };
                        }
                    }

                    if (deleteKey) {
                        entries.delete(keyToString(deleteKey));
                    }

                    return { ok: true };
                },
            };
        },
        size() {
            return entries.size;
        },
    };
}

type StoredKvEntry = Readonly<{
    key: readonly unknown[];
    value: ResourceEntry;
    versionstamp: string;
}>;

function createEntry(
    resourceId: string,
    options: Partial<Readonly<{ expiryTs: Temporal.Instant }>> = {},
): ResourceEntry {
    return {
        key: {
            topicId: 'presence.state.v1',
            resourceId,
            contextId: 'ctx-1',
        },
        resource: JSON.stringify({ text: resourceId }),
        typeId: 'presence.state.v1',
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: 'test',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: options.expiryTs ?? NEVER_EXPIRE_TS,
        },
        status: EntityStatus.NEW,
        dequeueAudit: {
            attempts: 0,
        },
    };
}

function keyToString(key: readonly unknown[]): string {
    return JSON.stringify(key);
}

function hasPrefix(key: readonly unknown[], prefix: readonly unknown[]): boolean {
    return prefix.every((segment, index) => key[index] === segment);
}
