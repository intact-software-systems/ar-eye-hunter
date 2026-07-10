import assert from 'node:assert/strict';
import type { AuthSession } from '@shared/api/api-config.ts';
import { requireApiAdminSession } from '../src/services/admin-auth-service.ts';

const ADMIN_SESSION: AuthSession = {
  clientId: 'platform-admin',
  username: 'admin',
  accessToken: 'access-token',
  sessionId: 'admin-session',
  expiresAtEpochMs: 1_700_000_060_000,
};

Deno.test('requireApiAdminSession allows configured admin clients', async () => {
  const session = await requireApiAdminSession(
    {
      header: () => undefined,
    },
    {
      adminClientIds: ['platform-admin'],
      requireApiAuthSession: () => Promise.resolve(ADMIN_SESSION),
    },
  );

  assert.equal(session.clientId, 'platform-admin');
});

Deno.test('requireApiAdminSession preserves unauthenticated failures', async () => {
  await assert.rejects(
    () =>
      requireApiAdminSession(
        {
          header: () => undefined,
        },
        {
          adminClientIds: ['platform-admin'],
          requireApiAuthSession: () =>
            Promise.reject(new Error('Unauthorized: Missing bearer token')),
        },
      ),
    /Unauthorized: Missing bearer token/,
  );
});

Deno.test('requireApiAdminSession rejects authenticated non-admin clients', async () => {
  await assert.rejects(
    () =>
      requireApiAdminSession(
        {
          header: () => undefined,
        },
        {
          adminClientIds: ['platform-admin'],
          requireApiAuthSession: () =>
            Promise.resolve({
              ...ADMIN_SESSION,
              clientId: 'regular-client',
              sessionId: 'regular-session',
            }),
        },
      ),
    /Forbidden: platform admin authorization required/,
  );
});
