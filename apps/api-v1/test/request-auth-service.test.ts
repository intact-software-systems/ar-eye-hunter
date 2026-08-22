import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type { RuntimeStateEntry, RuntimeStateTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { Either } from '@shared/resilience/Either.ts';
import assert from 'node:assert/strict';
import { requireApiAuthSession, requireWsAuthSession } from '../src/services/request-auth-service.ts';

Deno.test('requireApiAuthSession validates bearer token and client id', async () => {
    const repository = new AuthSessionRepository(new FakeRuntimeStateRepository());
    const session = {
        clientId: 'client-1',
        accessToken: 'token-1',
        username: 'alice',
        sessionId: 'session-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: Date.now() + 60_000
    };
    await repository.putSession(session);

    const authorised = await requireApiAuthSession(
        {
            header(name) {
                switch (name) {
                    case 'authorization':
                        return 'Bearer token-1';
                    case 'x-client-id':
                        return 'client-1';
                    default:
                        return undefined;
                }
            }
        },
        repository
    );

    assert.equal(authorised.sessionId, 'session-1');
    assert.equal(authorised.clientId, 'client-1');

    await assert.rejects(
        () =>
            requireApiAuthSession(
                {
                    header(name) {
                        switch (name) {
                            case 'authorization':
                                return 'Bearer token-1';
                            case 'x-client-id':
                                return 'client-2';
                            default:
                                return undefined;
                        }
                    }
                },
                repository
            ),
        /Unauthorized: Access token does not match x-client-id/
    );
});

Deno.test('requireWsAuthSession consumes websocket tickets and rejects mismatches', async () => {
    const expiresAtEpochMs = Date.now() + 60_000;
    const session = {
        clientId: 'client-1',
        accessToken: 'token-1',
        username: 'alice',
        sessionId: 'session-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs
    };
    const tickets = new Map([['ticket-1', session], ['ticket-2', session]]);
    const appAuthInbox = {
        consumeWebSocketTicket: (input: { ticket: string; expectedSessionId: string; }) => {
            const current = tickets.get(input.ticket);
            if (!current || current.sessionId !== input.expectedSessionId) {
                return Promise.resolve(Either.ofLeft({ message: 'invalid' }));
            }
            tickets.delete(input.ticket);
            return Promise.resolve(Either.ofRight(current));
        }
    } as never;

    const authorised = await requireWsAuthSession(
        {
            sessionId: 'session-1',
            ticket: 'ticket-1'
        },
        appAuthInbox,
        { requestId: 'consume-1' }
    );
    assert.equal(authorised.clientId, 'client-1');

    await assert.rejects(
        () =>
            requireWsAuthSession(
                {
                    sessionId: 'session-1',
                    ticket: 'ticket-1'
                },
                appAuthInbox,
                { requestId: 'consume-2' }
            ),
        /Unauthorized: Invalid or expired websocket auth ticket/
    );

    await assert.rejects(
        () =>
            requireWsAuthSession(
                {
                    sessionId: 'session-2',
                    ticket: 'ticket-2'
                },
                appAuthInbox,
                { requestId: 'consume-3' }
            ),
        /Unauthorized: Invalid or expired websocket auth ticket/
    );

    await assert.rejects(
        () =>
            requireWsAuthSession(
                {
                    sessionId: 'session-1',
                    ticket: 'missing-ticket'
                },
                appAuthInbox,
                { requestId: 'consume-4' }
            ),
        /Unauthorized: Invalid or expired websocket auth ticket/
    );
});

class FakeRuntimeStateRepository implements RuntimeStateTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();

    async begin<T>(
        fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>
    ): Promise<T> {
        return await fn(this);
    }

    findEntry(
        namespace: string,
        key: string
    ): Promise<RuntimeStateEntry | undefined> {
        const entry = this.data.get(this.toKey(namespace, key));
        return Promise.resolve(entry ? { ...entry } : undefined);
    }

    findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        return Promise.resolve(
            [...this.data.entries()]
                .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key))
        );
    }

    findEntriesByPrefix(
        namespace: string,
        keyPrefix: string
    ): Promise<readonly RuntimeStateEntry[]> {
        return Promise.resolve(
            [...this.data.entries()]
                .filter(
                    ([compositeKey]) =>
                        this.toNamespace(compositeKey) === namespace &&
                        this.toStoreKey(compositeKey).startsWith(keyPrefix)
                )
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key))
        );
    }

    findEntriesByKeys(
        namespace: string,
        keys: readonly string[]
    ): Promise<readonly RuntimeStateEntry[]> {
        const keySet = new Set(keys);
        return Promise.resolve(
            [...this.data.entries()]
                .filter(([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    keySet.has(this.toStoreKey(compositeKey))
                )
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key))
        );
    }

    upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<void> {
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0
        });
        return Promise.resolve();
    }

    deleteByKey(namespace: string, key: string): Promise<void> {
        this.data.delete(this.toKey(namespace, key));
        return Promise.resolve();
    }

    deleteExpired(namespace: string): Promise<number> {
        let deleted = 0;

        for (const [compositeKey, entry] of this.data.entries()) {
            if (this.toNamespace(compositeKey) !== namespace) {
                continue;
            }

            if (entry.expireAtTimestamp > Date.now()) {
                continue;
            }

            this.data.delete(compositeKey);
            deleted += 1;
        }

        return Promise.resolve(deleted);
    }

    async lockKey(_namespace: string, _key: string): Promise<void> {
    }

    private toKey(namespace: string, key: string): string {
        return `${namespace}::${key}`;
    }

    private toNamespace(compositeKey: string): string {
        return compositeKey.split('::', 1)[0] ?? '';
    }

    private toStoreKey(compositeKey: string): string {
        return compositeKey.slice(this.toNamespace(compositeKey).length + 2);
    }
}
