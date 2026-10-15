import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import { ALStorageReadiness } from '@shared/alm/storage/al-storage-readiness.ts';
import { ALStorageUnavailableError } from '@shared/alm/storage/al-storage-unavailable.ts';

const OPEN_FAILED = new ALStorageUnavailableError({
    cause: 'open-failed',
    detail: 'IndexedDB open of "al-runtime" failed: UnknownError: boom'
});

describe('ALStorageReadiness', () => {
    it('opens the stores once at construction and starts the work after the open', async () => {
        const calls: string[] = [];
        const readiness = new ALStorageReadiness({
            openStores: async () => {
                calls.push('open');
            },
            startWork: async () => {
                calls.push('work');
            },
            storageHealth: undefined
        });

        expect(calls).toEqual(['open']);
        expect((await readiness.ready()).right).toBe('ready');
        expect((await readiness.ready()).right).toBe('ready');
        expect(calls).toEqual(['open', 'work', 'work']);
    });

    // A store that cannot open answers as a value, states failing once, and the next call opens again.
    it('answers a storage failure as a value, records it and retries the open on the next call', async () => {
        const events: ALStorageEvent[] = [];
        const calls: string[] = [];
        const readiness = new ALStorageReadiness({
            openStores: async () => {
                calls.push('open');
                if (calls.length === 1) {
                    throw OPEN_FAILED;
                }
            },
            startWork: async () => {
                calls.push('work');
            },
            storageHealth: new ALStorageHealth({
                storeId: 'store-1',
                storage: (event) => events.push(event)
            })
        });

        const failed = await readiness.ready();
        const opened = await readiness.ready();

        expect(failed.left).toEqual(OPEN_FAILED.unavailable);
        expect(opened.right).toBe('ready');
        expect(calls).toEqual(['open', 'open', 'work']);
        await vi.waitFor(() =>
            expect(events).toEqual([{
                kind: 'health',
                storeId: 'store-1',
                status: 'failing',
                lastFailure: OPEN_FAILED.unavailable,
                lastRecoveryPointAtMs: undefined
            }])
        );
    });

    // The idle engine probes through this read: a store whose open failed reads nothing until a call opens it.
    it('answers the idle read without touching storage while the last open failed, and reads once it opened', async () => {
        let opens = 0;
        const reads: string[] = [];
        const readiness = new ALStorageReadiness({
            openStores: async () => {
                opens += 1;
                if (opens === 1) {
                    throw OPEN_FAILED;
                }
            },
            startWork: async () => {},
            storageHealth: undefined
        });
        const read = async () => {
            reads.push('read');
            return 'row';
        };

        const whileFailed = await readiness.readOpenedStore(read, 'none');
        const failed = await readiness.ready();
        const opened = await readiness.ready();
        const afterReady = await readiness.readOpenedStore(read, 'none');

        expect(whileFailed).toBe('none');
        expect([failed.left?.cause, opened.right]).toEqual(['open-failed', 'ready']);
        expect(afterReady).toBe('row');
        expect(reads).toEqual(['read']);
    });

    // Two callers awaiting one failed open both clear it; the later clear must not discard an open started between them.
    it('keeps an open started while another caller of the failed open has yet to resume', async () => {
        let opens = 0;
        const release = Promise.withResolvers<void>();
        const readiness = new ALStorageReadiness({
            openStores: async () => {
                opens += 1;
                if (opens === 1) {
                    throw OPEN_FAILED;
                }
                await release.promise;
            },
            startWork: async () => {},
            storageHealth: undefined
        });
        onTestFinished(async () => {
            release.resolve();
            await readiness.dispose();
        });
        await readiness.readOpenedStore(async () => 'row', 'none');

        queueMicrotask(() => void readiness.ready());
        void readiness.ready();
        queueMicrotask(() => void readiness.ready());
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        void readiness.ready();

        expect(opens).toBe(2);
    });

    it('joins accepted admission work before disposal finishes and refuses later admission', async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const readiness = new ALStorageReadiness({
            openStores: async () => {},
            startWork: async () => {},
            storageHealth: undefined
        });
        const admission = readiness.runStoreOperation(async () => {
            entered.resolve();
            await release.promise;
            return 'persisted';
        }, () => 'unavailable');
        onTestFinished(async () => {
            release.resolve();
            await admission;
            await readiness.dispose();
        });
        await entered.promise;
        let disposed = false;
        const closing = readiness.dispose().then(() => {
            disposed = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(disposed).toBe(false);
        release.resolve();
        await expect(admission).resolves.toBe('persisted');
        await closing;
        await expect(readiness.runStoreOperation(async () => 'new', () => 'unavailable')).rejects.toThrow('disposed');
    });

    it.each(['success', 'storage-failure', 'unexpected-failure'] as const)(
        'observes the accepted %s after disposal without reopening or starting work',
        async (outcome) => {
            const failure = new Error('original opening failure');
            const calls: string[] = [];
            const readiness = new ALStorageReadiness({
                openStores: async () => {
                    calls.push('open');
                    if (outcome === 'storage-failure') {
                        throw OPEN_FAILED;
                    }
                    if (outcome === 'unexpected-failure') {
                        throw failure;
                    }
                },
                startWork: async () => {
                    calls.push('work');
                },
                storageHealth: undefined
            });
            if (outcome === 'unexpected-failure') {
                await expect(readiness.ready()).rejects.toBe(failure);
                await expect(readiness.dispose()).rejects.toBe(failure);
                await expect(readiness.ready()).rejects.toBe(failure);
            }
            else {
                const accepted = await readiness.ready();
                await readiness.dispose();
                expect(await readiness.ready()).toEqual(accepted);
                expect(accepted.right).toBe(outcome === 'success' ? 'ready' : undefined);
                expect(accepted.left).toEqual(outcome === 'storage-failure' ? OPEN_FAILED.unavailable : undefined);
            }
            expect(calls).toEqual(outcome === 'success' ? ['open', 'work'] : ['open']);
            await expect(readiness.runStoreOperation(async () => 'new')).rejects.toThrow('disposed');
        }
    );

    it.each(['success', 'failure'] as const)('joins a pending %s observation after retirement', async (outcome) => {
        const opening = Promise.withResolvers<void>();
        const failure = new Error('pending opening failed');
        const calls: string[] = [];
        const readiness = new ALStorageReadiness({
            openStores: () => {
                calls.push('open');
                return opening.promise;
            },
            startWork: async () => {
                calls.push('work');
            },
            storageHealth: undefined
        });
        const closing = readiness.dispose();
        const observed = readiness.ready();
        const settled = Promise.allSettled([closing, observed]);
        onTestFinished(async () => {
            opening.resolve();
            for (const result of await settled) {
                if (result.status === 'rejected') {
                    expect(outcome).toBe('failure');
                    expect(result.reason).toBe(failure);
                }
            }
        });
        let observationFinished = false;
        void observed.then(() => {
            observationFinished = true;
        }, () => {
            observationFinished = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(observationFinished).toBe(false);
        if (outcome === 'failure') {
            opening.reject(failure);
            await expect(observed).rejects.toBe(failure);
            await expect(closing).rejects.toBe(failure);
        }
        else {
            opening.resolve();
            expect((await observed).right).toBe('ready');
            await closing;
        }
        expect(calls).toEqual(['open']);
    });

    it('rethrows an open failure that is no storage failure', async () => {
        const readiness = new ALStorageReadiness({
            openStores: async () => {
                throw new Error('ALM storage al-runtime still mismatches after reset');
            },
            startWork: async () => {},
            storageHealth: undefined
        });

        await expect(readiness.ready()).rejects.toThrow('still mismatches after reset');
    });
});
