import assert from 'node:assert/strict';
import { AuthUserRepository } from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';
import { login, readAuthorisedClients, register } from '../src/services/api-login-service.ts';
import type {
  RuntimeStateEntry,
  RuntimeStateTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

Deno.test('register prepares a mandatory user command without writing before AppInbox', async () => {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const registered = await register({
    request: {
      username: 'new-user',
      password: 'secret',
      displayName: 'New User',
    },
    staticClients: readAuthorisedClients(Deno.env),
    capturedAtEpochMs: 1_234,
    clientId: 'client-1',
  });

  assert.equal(registered.username, 'new-user');
  assert.equal(registered.displayName, 'New User');
  assert.equal(registered.createdAtEpochMs, 1_234);
  assert.equal(registered.displayName, 'New User');
  assert.equal(runtimeRepository.data.size, 0);

  const userRepository = new AuthUserRepository(runtimeRepository);
  await userRepository.putUser(registered);
  const session = await login({
    request: {
      username: 'new-user',
      password: 'secret',
    },
    userRepository,
    staticClients: readAuthorisedClients(Deno.env),
  });

  assert.ok(session);
  assert.equal(session.clientId, registered.clientId);
  assert.equal(session.username, 'new-user');

  assert.equal(
    await login({
      request: {
        username: 'new-user',
        password: 'wrong',
      },
      userRepository,
      staticClients: readAuthorisedClients(Deno.env),
    }),
    undefined,
  );
});

Deno.test('register rejects usernames reserved by static dev clients', async () => {
  await assert.rejects(
    () =>
      register({
        request: {
          username: 'admin',
          password: 'secret',
        },
        staticClients: readAuthorisedClients(Deno.env),
        capturedAtEpochMs: 1_234,
        clientId: 'client-1',
      }),
    /Auth user already exists: admin/,
  );
});

Deno.test('AUTH_STATIC_CLIENTS_MODE=disabled removes demo clients and frees reserved names', async () => {
  await withEnv('AUTH_STATIC_CLIENTS_MODE', 'disabled', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const registered = await register({
      request: {
        username: 'admin',
        password: 'secret',
        displayName: 'Runtime Admin',
      },
      staticClients: readAuthorisedClients(Deno.env),
      capturedAtEpochMs: 1_234,
      clientId: 'client-1',
    });

    assert.equal(registered.username, 'admin');

    const userRepository = new AuthUserRepository(runtimeRepository);
    await userRepository.putUser(registered);
    assert.equal(
      await login({
        request: {
          username: 'admin',
          password: 'admin',
        },
        userRepository,
        staticClients: readAuthorisedClients(Deno.env),
      }),
      undefined,
    );

    const session = await login({
      request: {
        username: 'admin',
        password: 'secret',
      },
      userRepository,
      staticClients: readAuthorisedClients(Deno.env),
    });
    assert.ok(session);
    assert.equal(session.clientId, registered.clientId);
  });
});

async function withEnv<T>(
  key: string,
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = Deno.env.get(key);
  try {
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
    return await fn();
  } finally {
    if (previous === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, previous);
    }
  }
}

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

  findEntriesByKeys(
    namespace: string,
    keys: readonly string[],
  ): Promise<readonly RuntimeStateEntry[]> {
    const keySet = new Set(keys);
    return Promise.resolve(
      [...this.data.entries()]
        .filter(([compositeKey]) =>
          this.toNamespace(compositeKey) === namespace &&
          keySet.has(this.toStoreKey(compositeKey))
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
