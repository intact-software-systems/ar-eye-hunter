import { describe, expect, it } from 'vitest';

import { createLifecycleSql, withPostgresClients } from './postgres-runtime-state-client-fixtures.ts';

describe('Postgres runtime-state client lifecycle', () => {
    it('closes acquired clients and preserves an acquisition failure', async () => {
        const setupFailure = new Error('second client failed');
        let createCalls = 0;
        let endCalls = 0;
        let runCalls = 0;
        const firstClient = createLifecycleSql(
            () => Promise.reject(new Error('cleanup query failed')),
            () => {
                endCalls += 1;
                return Promise.resolve();
            }
        );

        await expect(
            withPostgresClients(
                {
                    namespace: 'acquisition-failure',
                    clientCount: 2,
                    createClient: () => {
                        createCalls += 1;
                        if (createCalls === 1) {
                            return Promise.resolve(firstClient);
                        }
                        throw setupFailure;
                    }
                },
                () => {
                    runCalls += 1;
                    return Promise.resolve();
                }
            )
        ).rejects.toBe(setupFailure);
        expect(createCalls).toBe(2);
        expect(runCalls).toBe(0);
        expect(endCalls).toBe(1);
    });

    it('closes acquired clients and preserves an acquisition failure when cleanup throws synchronously', async () => {
        const setupFailure = new Error('second client failed');
        const cleanupFailure = new Error('cleanup query threw synchronously');
        let createCalls = 0;
        let endCalls = 0;
        const firstClient = createLifecycleSql(
            () => {
                throw cleanupFailure;
            },
            () => {
                endCalls += 1;
                return Promise.resolve();
            }
        );

        await expect(
            withPostgresClients(
                {
                    namespace: 'synchronous-cleanup-acquisition-failure',
                    clientCount: 2,
                    createClient: () => {
                        createCalls += 1;
                        if (createCalls === 1) {
                            return Promise.resolve(firstClient);
                        }
                        throw setupFailure;
                    }
                },
                () => Promise.resolve()
            )
        ).rejects.toBe(setupFailure);
        expect(createCalls).toBe(2);
        expect(endCalls).toBe(1);
    });

    it('aggregates a cleanup-only synchronous query failure after closing clients', async () => {
        const cleanupFailure = new Error('cleanup query threw synchronously');
        let endCalls = 0;
        const client = createLifecycleSql(
            () => {
                throw cleanupFailure;
            },
            () => {
                endCalls += 1;
                return Promise.resolve();
            }
        );

        await expect(
            withPostgresClients(
                { namespace: 'synchronous-cleanup-only-failure', clientCount: 1, createClient: () => Promise.resolve(client) },
                () => Promise.resolve(undefined)
            )
        ).rejects.toMatchObject({
            errors: [cleanupFailure]
        });
        expect(endCalls).toBe(1);
    });
});
