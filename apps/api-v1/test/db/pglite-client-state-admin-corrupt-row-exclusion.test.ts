import assert from 'node:assert/strict';

import type { StateScope } from '@shared/api/state-types.ts';
import { PSqlAdminOperationsStatsReader } from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

Deno.test('PGlite global admin client metrics exclude noncanonical and mismatched rows', async () => {
  await withPGliteSql(async (sql) => {
    const applicationId = 'global-corrupt-client-admin-state';
    await insertCorruptAdminClientRows(sql, applicationId);

    const state = await readAdminState(sql);

    assert.deepEqual(state.clients, {
      totalPrincipals: 1,
      onlinePrincipals: 1,
      activeSessions: 1,
    });
  });
});

Deno.test('PGlite scoped admin client metrics exclude noncanonical and mismatched rows', async () => {
  await withPGliteSql(async (sql) => {
    const applicationId = 'scoped-corrupt-client-admin-state';
    await insertCorruptAdminClientRows(sql, applicationId);

    const state = await readAdminState(sql, { applicationId, workspaceId: '_' });

    assert.deepEqual(state.clients, {
      totalPrincipals: 1,
      onlinePrincipals: 1,
      activeSessions: 1,
    });
  });
});

async function readAdminState(sql: PGliteSql, scope?: StateScope) {
  const reader = new PSqlAdminOperationsStatsReader(sql, {
    now: () => 1_700_000_000_000,
  });
  return await reader.readState({ adminSession: createAdminSession(), scope });
}

async function insertCorruptAdminClientRows(
  sql: PGliteSql,
  applicationId: string,
): Promise<void> {
  const canonicalPrefix = `app=${applicationId}:ws=%5F:principal=`;
  const rows = [
    {
      namespace: 'client-state:principals',
      key: `${canonicalPrefix}valid`,
      value: {
        applicationId,
        workspaceId: '_',
        principalId: 'valid',
      },
    },
    {
      namespace: 'client-state:principals',
      key: `app=${applicationId}:ws=_:principal=legacy-alias`,
      value: {
        applicationId,
        workspaceId: '_',
        principalId: 'legacy-alias',
      },
    },
    {
      namespace: 'client-state:principals',
      key: `${canonicalPrefix}%61lias`,
      value: {
        applicationId,
        workspaceId: '_',
        principalId: 'alias',
      },
    },
    {
      namespace: 'client-state:principals',
      key: `${canonicalPrefix}mismatched-slot`,
      value: {
        applicationId,
        workspaceId: '_',
        principalId: 'mismatched-value',
      },
    },
    {
      namespace: 'client-state:sessions',
      key: `${canonicalPrefix}valid:instance=browser:session=valid-session`,
      value: createActiveClientSessionValue({
        applicationId,
        principalId: 'valid',
        sessionId: 'valid-session',
      }),
    },
    {
      namespace: 'client-state:sessions',
      key: `app=${applicationId}:ws=_:principal=legacy-alias:` +
        'instance=browser:session=legacy-session',
      value: createActiveClientSessionValue({
        applicationId,
        principalId: 'legacy-alias',
        sessionId: 'legacy-session',
      }),
    },
    {
      namespace: 'client-state:sessions',
      key: `${canonicalPrefix}%61lias:instance=browser:session=alias-session`,
      value: createActiveClientSessionValue({
        applicationId,
        principalId: 'alias',
        sessionId: 'alias-session',
      }),
    },
    {
      namespace: 'client-state:sessions',
      key: `${canonicalPrefix}mismatched-slot:` +
        'instance=browser:session=mismatched-session',
      value: createActiveClientSessionValue({
        applicationId,
        principalId: 'mismatched-value',
        sessionId: 'mismatched-session',
      }),
    },
  ] as const;

  for (const row of rows) {
    await sql`
      insert into runtime_state_store (
        store_namespace, store_key, store_value, expire_at_ts
      )
      values (
        ${row.namespace}, ${row.key}, ${JSON.stringify(row.value)},
        ${new Date('9999-12-31T23:59:59Z')}
      )
    `;
  }
}

function createActiveClientSessionValue(
  input: Readonly<{
    applicationId: string;
    principalId: string;
    sessionId: string;
  }>,
) {
  return {
    applicationId: input.applicationId,
    workspaceId: '_',
    principalId: input.principalId,
    clientInstanceId: 'browser',
    sessionId: input.sessionId,
    status: 'active',
    expiresAtEpochMs: 1_700_000_060_000,
  };
}

function createAdminSession() {
  return {
    clientId: 'platform-admin',
    username: 'admin',
    accessToken: 'access-token',
    sessionId: 'admin-session',
    expiresAtEpochMs: 1_700_000_060_000,
  };
}
