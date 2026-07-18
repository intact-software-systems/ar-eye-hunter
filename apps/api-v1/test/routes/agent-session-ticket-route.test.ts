import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import type {
  AgentSessionTicketResponse,
  AuthSession,
  ConsumeAgentSessionTicketResponse,
} from '@shared/api/api-config.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type {
  RuntimeStateEntry,
  RuntimeStateTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import * as configRoutes from '../../src/routes/config-route.ts';

const NOW_EPOCH_MS = Date.now();

Deno.test('agent session ticket route rejects unauthenticated issue requests', async () => {
  const app = createApp({
    requireApiAuthSession: () => Promise.reject(new Error('Unauthorized: Missing bearer token')),
  });

  const response = await app.request('/api/auth/agent-session-tickets', {
    method: 'POST',
    body: JSON.stringify({ agentIds: ['controller-01'] }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: 'Unauthorized: Missing bearer token',
  });
});

Deno.test('agent session ticket route mints distinct same-user sessions and consumes a ticket once', async () => {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const app = createApp({
    requireApiAuthSession: () => Promise.resolve(createAuthSession()),
    createAuthSessionRepository: () => new AuthSessionRepository(runtimeRepository),
    now: () => NOW_EPOCH_MS,
  });

  const issueResponse = await app.request('/api/auth/agent-session-tickets', {
    method: 'POST',
    headers: {
      authorization: 'Bearer operator-token',
      'x-client-id': 'alice-client',
    },
    body: JSON.stringify({ agentIds: ['controller-01', 'controller-02'] }),
  });
  const issued = await issueResponse.json() as AgentSessionTicketResponse;

  assert.equal(issueResponse.status, 200);
  assert.equal(issued.tickets.length, 2);
  assert.deepEqual(issued.tickets.map((ticket) => ticket.agentId), [
    'controller-01',
    'controller-02',
  ]);
  assert.notEqual(issued.tickets[0].sessionId, 'operator-session');
  assert.notEqual(issued.tickets[0].sessionId, issued.tickets[1].sessionId);
  assert.ok(issued.tickets[0].ticket.length > 20);

  const consumeResponse = await app.request('/api/auth/agent-session-tickets/consume', {
    method: 'POST',
    body: JSON.stringify({ ticket: issued.tickets[0].ticket }),
  });
  const consumed = await consumeResponse.json() as ConsumeAgentSessionTicketResponse;

  assert.equal(consumeResponse.status, 200);
  assert.equal(consumed.clientId, 'alice-client');
  assert.equal(consumed.username, 'alice');
  assert.equal(consumed.sessionId, issued.tickets[0].sessionId);
  assert.ok(consumed.accessToken.length > 20);
  assert.equal(issued.tickets[0].expiresAtEpochMs, NOW_EPOCH_MS + 60_000);
  assert.equal(consumed.expiresAtEpochMs, NOW_EPOCH_MS + 86_400_000);

  const repeatConsumeResponse = await app.request('/api/auth/agent-session-tickets/consume', {
    method: 'POST',
    body: JSON.stringify({ ticket: issued.tickets[0].ticket }),
  });

  assert.equal(repeatConsumeResponse.status, 404);
  assert.deepEqual(await repeatConsumeResponse.json(), {
    error: 'Agent session ticket is invalid or expired.',
  });
});

function createApp(
  dependencies: configRoutes.ConfigRouteDependencies,
): Hono {
  const app = new Hono();
  configRoutes.init(app, dependencies);
  return app;
}

function createAuthSession(): AuthSession {
  return {
    clientId: 'alice-client',
    username: 'alice',
    accessToken: 'operator-token',
    sessionId: 'operator-session',
    expiresAtEpochMs: NOW_EPOCH_MS + 86_400_000,
  };
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
