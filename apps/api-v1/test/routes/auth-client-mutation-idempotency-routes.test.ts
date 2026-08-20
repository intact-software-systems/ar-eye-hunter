import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import { Either } from '@shared/resilience/Either.ts';
import type { ApiMutationFailure } from '@shared/api/mutation/api-mutation.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';

import * as clientStateRoutes from '../../src/routes/client-state-routes.ts';
import * as configRoutes from '../../src/routes/config-route.ts';
import {
  createAuthSession,
  createClientRouteDeps,
  createClientSnapshot,
  toClientStateWritten,
} from '../client-state/client-state-route-test-runtime.ts';

const REQUEST_ID = 'Request_ID-012345678';
const AUTH_SESSION = {
  clientId: 'alice',
  username: 'Alice',
  accessToken: 'access-token',
  sessionId: 'alice-session',
  issuedAtEpochMs: 1_000,
  expiresAtEpochMs: 61_000,
} as const;

Deno.test('auth logout accepts only the case-sensitive path request ID', async () => {
  const calls: Array<
    Parameters<
      configRoutes.ConfigRouteDependencies['appAuthInbox']['logoutSession']
    >[0]
  > = [];
  const app = createConfigRouteApp({
    appAuthInbox: ({
      logoutSession: (
        value: Parameters<
          configRoutes.ConfigRouteDependencies['appAuthInbox']['logoutSession']
        >[0],
      ) => {
        calls.push(value);
        return Promise.resolve(Either.ofRight({ loggedOut: true }));
      },
    }) as never,
  });

  const response = await app.request(`/api/auth/logout/requests/${REQUEST_ID}`, {
    method: 'POST',
    headers: { authorization: 'Bearer access-token', 'x-client-id': 'alice' },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { loggedOut: true });
  assert.deepEqual(calls, [{
    requestId: REQUEST_ID,
    capturedAtEpochMs: 2_000,
    session: AUTH_SESSION,
  }]);
  assert.equal((await app.request('/api/auth/logout', { method: 'POST' })).status, 404);
});

Deno.test(
  'auth mutation ingress rejects header and body identity with canonical failures',
  async () => {
    const app = createConfigRouteApp();
    for (const identity of ['header', 'body'] as const) {
      const response = await app.request(`/api/auth/logout/requests/${REQUEST_ID}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'x-client-id': 'alice',
          'content-type': 'application/json',
          ...(identity === 'header' ? { 'idempotency-key': REQUEST_ID } : {}),
        },
        body: JSON.stringify(identity === 'body' ? { requestId: REQUEST_ID } : {}),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(
        await response.json(),
        mutationFailure({
          code: 'api-mutation-request-invalid',
          status: 400,
          message: 'API mutation requestId must be supplied only by the request path',
          issues: [{
            code: 'api-mutation-request-invalid',
            path: null,
            message: 'API mutation requestId must be supplied only by the request path',
            details: null,
          }],
        }),
      );
    }
  },
);

Deno.test(
  'auth failure authenticates before replay disclosure and uses the canonical envelope',
  async () => {
    let inboxCalls = 0;
    const app = createConfigRouteApp({
      requireApiAuthSession: () => Promise.reject(new Error('Unauthorized: invalid credential')),
      appAuthInbox: ({
        logoutSession: () => {
          inboxCalls += 1;
          return Promise.resolve(Either.ofRight({ loggedOut: true }));
        },
      }) as never,
    });

    const response = await app.request(`/api/auth/logout/requests/${REQUEST_ID}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(
      await response.json(),
      mutationFailure({
        code: 'authentication-required',
        status: 401,
        message: 'Unauthorized: invalid credential',
        denial: {
          code: 'authentication-required',
          message: 'Unauthorized: invalid credential',
          details: null,
        },
      }),
    );
    assert.equal(inboxCalls, 0);
  },
);

Deno.test('logout reauthenticates before credential-proof replay disclosure', async () => {
  const proofCalls: Array<
    Parameters<
      configRoutes.ConfigRouteDependencies[
        'appAuthInbox'
      ]['replayLogoutSessionWithCredentialProof']
    >[0]
  > = [];
  let liveLogoutCalls = 0;
  const app = createConfigRouteApp({
    requireApiAuthSession: () => Promise.reject(new Error('Unauthorized: session invalidated')),
    appAuthInbox: ({
      logoutSession: () => {
        liveLogoutCalls += 1;
        return Promise.resolve(Either.ofRight({ loggedOut: true }));
      },
      replayLogoutSessionWithCredentialProof: (
        proof: Parameters<
          configRoutes.ConfigRouteDependencies[
            'appAuthInbox'
          ]['replayLogoutSessionWithCredentialProof']
        >[0],
      ) => {
        proofCalls.push(proof);
        return Promise.resolve(Either.ofRight({ loggedOut: true }));
      },
    }) as never,
  });

  const response = await app.request(`/api/auth/logout/requests/${REQUEST_ID}`, {
    method: 'POST',
    headers: { authorization: 'Bearer invalidated-token', 'x-client-id': 'alice' },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { loggedOut: true });
  assert.equal(liveLogoutCalls, 0);
  assert.deepEqual(proofCalls, [{
    requestId: REQUEST_ID,
    accessToken: 'invalidated-token',
    clientId: 'alice',
  }]);
});

Deno.test(
  'login, register, and websocket-ticket issue expose only strict request paths',
  async () => {
    const app = createConfigRouteApp({
      staticClients: [{ clientId: 'alice', username: 'alice', password: 'password' }],
      authUserRepository: {
        findByNormalizedUsernameEntry: () => Promise.resolve(undefined),
      } as never,
      appAuthInbox: ({
        issueSession: () =>
          Promise.resolve(Either.ofRight({
            clientId: 'alice',
            username: 'alice',
            accessToken: 'login-access-token',
            sessionId: 'login-session',
            expiresAtEpochMs: 61_000,
          })),
        registerUser: (
          input: {
            user: {
              clientId: string;
              username: string;
              displayName: string | null;
              createdAtEpochMs: number;
            };
          },
        ) =>
          Promise.resolve(Either.ofRight({
            clientId: input.user.clientId,
            username: input.user.username,
            displayName: input.user.displayName,
            registeredAtEpochMs: input.user.createdAtEpochMs,
          })),
        issueWebSocketTicket: () =>
          Promise.resolve(Either.ofRight({
            ticket: 'websocket-ticket',
            sessionId: AUTH_SESSION.sessionId,
            expiresAtEpochMs: 32_000,
          })),
      }) as never,
    });

    const login = await app.request('/api/auth/login/requests/LoginMutationRequest_01234', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password' }),
    });
    const registration = await app.request(
      '/api/auth/register/requests/RegisterMutationRequest_012',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'new-user', password: 'password' }),
      },
    );
    const websocketTicket = await app.request(
      '/api/auth/ws-ticket/requests/WebSocketMutationRequest_01',
      {
        method: 'POST',
        headers: { authorization: 'Bearer access-token', 'x-client-id': 'alice' },
        body: JSON.stringify({}),
      },
    );

    assert.equal(login.status, 200, await login.clone().text());
    assert.equal(registration.status, 201, await registration.clone().text());
    assert.equal(websocketTicket.status, 200, await websocketTicket.clone().text());
    for (const oldPath of ['/api/auth/login', '/api/auth/register', '/api/auth/ws-ticket']) {
      assert.equal((await app.request(oldPath, { method: 'POST' })).status, 404);
    }
  },
);

Deno.test('registration validation failure uses the canonical envelope', async () => {
  const app = createConfigRouteApp();
  const response = await app.request(
    '/api/auth/register/requests/RegisterValidationRequest_01',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'password' }),
    },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(
    await response.json(),
    mutationFailure({
      code: 'api-mutation-request-invalid',
      status: 400,
      message: 'Username is required',
      issues: [{
        code: 'api-mutation-request-invalid',
        path: null,
        message: 'Username is required',
        details: null,
      }],
    }),
  );
});

Deno.test('client mutation uses operation topic and target-plus-caller context', async () => {
  const enqueues: Array<{
    contextId?: string;
    resourceId?: string;
    topicId?: string;
  }> = [];
  const deps = createClientRouteDeps({
    session: createAuthSession('alice'),
    clientService: {},
    processClientAppInbox: (enqueue) => {
      enqueues.push(enqueue);
      return Promise.resolve(toClientStateWritten(createClientSnapshot('alice')));
    },
  });
  const app = new Hono();
  clientStateRoutes.registerClientStateRoutes(app, deps);
  const oldPath = '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/principal';
  const response = await app.request(`${oldPath}/requests/${REQUEST_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice' }),
  });

  assert.equal(response.status, 200);
  assert.equal(
    (await app.request(oldPath, {
      method: 'PUT',
      body: JSON.stringify({ username: 'alice' }),
    })).status,
    404,
  );
  assert.deepEqual(enqueues, [{
    type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    resourceId: REQUEST_ID,
    contextId:
      'application=app-1:workspace=workspace-1:principal=alice:caller=alice:session=alice-session',
    senderId: 'alice',
    data: {
      scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
      principalId: 'alice',
      request: {
        username: 'alice',
        requestId: REQUEST_ID,
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
      },
    },
  }]);
});

Deno.test(
  'client mutation rejects legacy identity before enqueue with a canonical failure',
  async () => {
    let inboxCalls = 0;
    const deps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {},
      processClientAppInbox: () => {
        inboxCalls += 1;
        return Promise.resolve(toClientStateWritten(createClientSnapshot('alice')));
      },
    });
    const app = new Hono();
    clientStateRoutes.registerClientStateRoutes(app, deps);
    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/principal/requests/' +
        REQUEST_ID,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': REQUEST_ID },
        body: JSON.stringify({ username: 'alice' }),
      },
    );

    assert.equal(response.status, 400);
    assert.equal(inboxCalls, 0);
    assert.deepEqual(
      await response.json(),
      mutationFailure({
        code: 'api-mutation-request-invalid',
        status: 400,
        message: 'API mutation requestId must be supplied only by the request path',
        issues: [{
          code: 'api-mutation-request-invalid',
          path: null,
          message: 'API mutation requestId must be supplied only by the request path',
          details: null,
        }],
      }),
    );
  },
);

Deno.test(
  'client callers reuse one request ID independently across application scope',
  async () => {
    const enqueues: { contextId?: string; resourceId?: string; topicId?: string }[] = [];
    const app = new Hono();
    clientStateRoutes.registerClientStateRoutes(
      app,
      createClientRouteDeps({
        session: createAuthSession('alice'),
        clientService: {},
        processClientAppInbox: (enqueue) => {
          enqueues.push(enqueue);
          return Promise.resolve(toClientStateWritten(createClientSnapshot('alice')));
        },
      }),
    );

    for (const applicationId of ['application-one', 'application-two']) {
      const response = await app.request(
        `/api/state/apps/${applicationId}/workspaces/workspace/clients/alice/principal/` +
          `requests/${REQUEST_ID}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'alice' }),
        },
      );
      assert.equal(response.status, 200);
    }

    assert.equal(enqueues.length, 2);
    assert.deepEqual(enqueues.map(({ resourceId, topicId }) => ({ resourceId, topicId })), [
      { resourceId: REQUEST_ID, topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT },
      { resourceId: REQUEST_ID, topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT },
    ]);
    assert.notEqual(enqueues[0].contextId, enqueues[1].contextId);
  },
);

Deno.test('every covered legacy auth and client mutation URL is absent', async () => {
  const app = createConfigRouteApp();
  clientStateRoutes.registerClientStateRoutes(
    app,
    createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {},
    }),
  );
  const client = '/api/state/apps/app/workspaces/workspace/clients/alice';
  const instance = `${client}/instances/browser`;
  const session = `${instance}/sessions/alice-session`;
  const legacyMutations = [
    ['POST', '/api/auth/register'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/ws-ticket'],
    ['POST', '/api/auth/agent-session-tickets'],
    ['POST', '/api/auth/agent-session-tickets/consume'],
    ['PUT', `${client}/principal`],
    ['PUT', instance],
    ['PUT', session],
    ['POST', `${session}/heartbeat`],
    ['POST', `${session}/disconnect`],
  ] as const;

  for (const [method, path] of legacyMutations) {
    const response = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});

function createConfigRouteApp(
  dependencies: Partial<configRoutes.ConfigRouteDependencies> = {},
): Hono {
  const app = new Hono();
  configRoutes.registerConfigRoutes(app, {
    requireApiAuthSession: () => Promise.resolve(AUTH_SESSION),
    readEnv: () => undefined,
    now: () => 2_000,
    createTokenId: () => 'server-generated-id-must-not-be-request-identity',
    appAuthInbox: ({
      logoutSession: () => Promise.resolve(Either.ofRight({ loggedOut: true })),
      replayLogoutSessionWithCredentialProof: () => Promise.resolve(null),
    }) as never,
    authUserRepository: {} as never,
    staticClients: [],
    registrationMode: 'public',
    adminClientIds: new Set(),
    ...dependencies,
  });
  return app;
}

interface FailureInput {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly issues?: readonly Readonly<{
    code: string;
    path: readonly (string | number)[] | null;
    message: string;
    details: null;
  }>[];
  readonly denial?: Readonly<{
    code: string;
    message: string;
    details: null;
  }>;
}

function mutationFailure(input: FailureInput): ApiMutationFailure {
  return {
    type: 'api-mutation-failure',
    version: 'canonical.v1',
    code: input.code,
    status: input.status,
    message: input.message,
    issues: input.issues ?? null,
    denial: input.denial ?? null,
    retry: null,
  };
}
