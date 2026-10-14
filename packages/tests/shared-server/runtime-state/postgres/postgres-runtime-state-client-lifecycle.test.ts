import {
    describe,
    expect,
    it
} from 'vitest';

import {
    createLifecycleSql,
    withPostgresClients
} from './postgres-runtime-state-client-fixtures.ts';

describe('Postgres runtime-state client lifecycle', () => {
    it.each(['body failure', 'cleanup failure'] as const)('closes every client without unrelated namespace work after %s', async (failure) => {
        const primaryFailure = new Error('body failed');
        const cleanupFailure = new Error('first close failed');
        let queryCalls = 0;
        const closed: number[] = [];
        const clients = [0, 1].map((index) =>
            createLifecycleSql(
                () => {
                    queryCalls += 1;
                    return Promise.resolve([]);
                },
                async () => {
                    closed.push(index);
                    if (index === 0) {
                        throw cleanupFailure;
                    }
                }
            )
        );
        let nextClient = 0;
        const result = withPostgresClients({
            namespace: null,
            clientCount: 2,
            createClient: async () => clients[nextClient++]!
        }, async () => {
            if (failure === 'body failure') {
                throw primaryFailure;
            }
        });

        if (failure === 'body failure') {
            await expect(result).rejects.toBe(primaryFailure);
        }
        else {
            await expect(result).rejects.toMatchObject({ errors: [cleanupFailure] });
        }
        expect(new Set(closed)).toEqual(new Set([0, 1]));
        expect(queryCalls).toBe(0);
    });

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
