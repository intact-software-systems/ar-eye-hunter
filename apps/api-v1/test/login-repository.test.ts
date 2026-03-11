import assert from 'node:assert/strict';
import { AuthUserRepository } from '../src/repository/AuthUserRepository.ts';
import { login, register } from '../src/repository/login-repository.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateTransactionalRepositoryLike,
} from '../src/repository/RuntimeStateRepository.ts';

Deno.test('register creates a runtime user that can log in', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const registered = await register(
        {
            username: 'new-user',
            password: 'secret',
            displayName: 'New User',
        },
        {
            runtimeRepository,
            now: () => 1_234,
        },
    );

    assert.equal(registered.username, 'new-user');
    assert.equal(registered.displayName, 'New User');
    assert.equal(registered.registeredAtEpochMs, 1_234);

    const userRepository = new AuthUserRepository(runtimeRepository);
    const session = await login(
        {
            username: 'new-user',
            password: 'secret',
        },
        {
            userRepository,
        },
    );

    assert.ok(session);
    assert.equal(session.clientId, registered.clientId);
    assert.equal(session.username, 'new-user');

    assert.equal(
        await login(
            {
                username: 'new-user',
                password: 'wrong',
            },
            {
                userRepository,
            },
        ),
        undefined,
    );
});

Deno.test('register rejects duplicate usernames case-insensitively', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await register(
        {
            username: 'New-User',
            password: 'secret',
        },
        {
            runtimeRepository,
        },
    );

    await assert.rejects(
        () =>
            register(
                {
                    username: 'new-user',
                    password: 'secret',
                },
                {
                    runtimeRepository,
                },
            ),
        /Auth user already exists: new-user/,
    );
});

Deno.test('register rejects usernames reserved by static dev clients', async () => {
    await assert.rejects(
        () =>
            register(
                {
                    username: 'admin',
                    password: 'secret',
                },
                {
                    runtimeRepository: new FakeRuntimeStateRepository(),
                },
            ),
        /Auth user already exists: admin/,
    );
});

class FakeRuntimeStateRepository implements RuntimeStateTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();

    async begin<T>(
        fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        return await fn(this);
    }

    findEntry(
        namespace: string,
        key: string,
    ): Promise<RuntimeStateEntry | undefined> {
        const entry = this.data.get(this.toKey(namespace, key));
        return Promise.resolve(entry ? { ...entry } : undefined);
    }

    findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        return Promise.resolve(
            [...this.data.entries()]
                .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key)),
        );
    }

    findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        return Promise.resolve(
            [...this.data.entries()]
                .filter(
                    ([compositeKey]) =>
                        this.toNamespace(compositeKey) === namespace &&
                        this.toStoreKey(compositeKey).startsWith(keyPrefix),
                )
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key)),
        );
    }

    upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<void> {
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0,
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
