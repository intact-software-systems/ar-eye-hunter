import assert from 'node:assert/strict';

import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { RallarServerWsFacade } from '@shared-server/rallar-facade/ws-topic-router.ts';
import type {
  RallarWsLifecycleHandlers,
} from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';

import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import type { ApiV1TopologyServices } from '../../src/composition/create-api-v1-topology-services.ts';
import {
  type ApiV1SystemInstallerOperations,
  constructApiV1SystemInstallers,
  type CreateApiV1SystemInstallersInput,
} from '../../src/composition/create-api-v1-system-installers.ts';
import * as wsRoutes from '../../src/routes/ws-routes.ts';
import {
  rememberAuthorisedWsConnection,
} from '../../src/runtime/rtc-topology/authorised-ws-connection-registry.ts';

Deno.test('system topic reinstall unregisters and stops the prior owner', () => {
  const events: string[] = [];
  const runtime = createRuntime(events);
  const installers = constructApiV1SystemInstallers(
    createInput(),
    createOperations(events),
  );
  const ws = {} as RallarServerWsFacade;

  installers.installDefaultMiddlewareTopics?.(runtime, ws);
  installers.installDefaultMiddlewareTopics?.(runtime, ws);

  assert.deepEqual(events, [
    'system-topics',
    'register-stop',
    'crdt-ingress',
    'crdt-topics',
    'unregister-stop',
    'stop-system-topics',
    'system-topics',
    'register-stop',
    'crdt-ingress',
    'crdt-topics',
  ]);
});

Deno.test('system topics fail after topic ownership when CRDT ingress is absent', () => {
  const events: string[] = [];
  const runtime = createRuntime(events, false);
  const installers = constructApiV1SystemInstallers(
    createInput(),
    createOperations(events),
  );

  assert.throws(
    () => installers.installDefaultMiddlewareTopics?.(runtime, {} as RallarServerWsFacade),
    /CRDT websocket topics require AppInbox mutation ingress/,
  );
  assert.deepEqual(events, ['system-topics', 'register-stop']);
});

Deno.test('websocket lifecycle preserves translations, retry policy, and stop ownership', async () => {
  const events: string[] = [];
  const calls: RuntimeCalls = {};
  const runtime = createRuntime(events, true, calls);
  let handlers: RallarWsLifecycleHandlers | undefined;
  const operations: ApiV1SystemInstallerOperations = {
    ...createOperations(events),
    initWebSocketLifecycle: (_service, input) => {
      events.push('ws-lifecycle');
      handlers = input;
      return {
        getPendingCloseCount: () => 0,
        retryPending: () => Promise.resolve(),
        stop: () => {},
      };
    },
  };
  const installers = constructApiV1SystemInstallers(createInput(), operations);
  installers.installWebSocketLifecycle?.(runtime, {} as RallarServerWsFacade);

  const close = {
    sessionId: 'session-1',
    generationId: 'generation-1',
    generationStartedAtEpochMs: 100,
    disconnectedAtEpochMs: 200,
    reason: 'closed',
  };
  rememberAuthorisedWsConnection('session-1', 'generation-1', {
    authSession: {
      clientId: 'alice',
      username: 'alice',
      sessionId: 'session-1',
      issuedAtEpochMs: 1,
      expiresAtEpochMs: 10_000,
    },
    generationId: 'generation-1',
    generationStartedAtEpochMs: 100,
    scope: { applicationId: 'app', workspaceId: 'workspace' },
    principalId: 'alice',
    clientInstanceId: 'browser',
    displayName: 'Alice',
    userAgent: null,
    platform: 'web',
    capabilities: [],
    expiresAtEpochMs: 10_000,
  });
  await handlers?.enqueueClientSessionDisconnect(close);
  await handlers?.enqueueGroupSessionCleanup(close);

  assert.deepEqual(events, [
    'ws-lifecycle',
    'register-stop',
    'client-disconnect',
    'group-cleanup',
  ]);
  assert.deepEqual(handlers?.retry.delaysMs, [
    ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY.delaysAfterAttemptMs,
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxDelayMs,
  ]);
  assert.equal(handlers?.hasCloseFacts, wsRoutes.hasAuthorisedWsCloseFacts);
  assert.equal(handlers?.releaseCloseFacts, wsRoutes.releaseAuthorisedWsCloseFacts);
  assert.deepEqual(calls.clientDisconnect, wsRoutes.toAuthorisedWsClientDisconnectInput(close));
  assert.deepEqual(calls.groupCleanup, wsRoutes.toGroupPresenceSessionCleanupInput(close));
});

interface RuntimeCalls {
  clientDisconnect?: unknown;
  groupCleanup?: unknown;
}

function createInput(): CreateApiV1SystemInstallersInput {
  return {
    database: Object.assign(() => Promise.resolve([]), {
      begin: () => Promise.reject(new Error('not used')),
    }),
    serviceId: 'api-test',
    nowEpochMs: () => 1_000,
    topology: {} as ApiV1TopologyServices,
    crdtLogRepository: {} as RallarCrdtAdminReadRepository,
    crdtPolicies: undefined,
    globalGraphRecomputeLimit: undefined,
  };
}

function createRuntime(
  events: string[],
  includeCrdt = true,
  calls: RuntimeCalls = {},
): ApiV1Runtime {
  return {
    wsQBoxServerService: {},
    appClientInboxService: {
      enqueueAuthorisedWsClientDisconnect: (input: unknown) => {
        calls.clientDisconnect = input;
        events.push('client-disconnect');
        return Promise.resolve(undefined);
      },
    },
    appGroupInboxService: {
      enqueueGroupSessionCleanup: (input: unknown) => {
        calls.groupCleanup = input;
        events.push('group-cleanup');
        return Promise.resolve(undefined);
      },
      enqueueRtcRtt: () => Promise.resolve(undefined),
    },
    appCrdtInboxService: includeCrdt ? {} : undefined,
    backgroundTasks: {
      register: () => {
        events.push('register-stop');
        return () => events.push('unregister-stop');
      },
    },
    groupStateService: {},
    clientStateService: {},
    outboxQueueReader: {},
    qboxEngine: { wake: () => {} },
    rtcTopologyReplay: { wake: () => {} },
    rtcTopologyExecutionRepository: {},
    rtcTopologyDelivery: {},
  } as never;
}

function createOperations(events: string[]): ApiV1SystemInstallerOperations {
  return {
    initialiseSystemTopics: () => {
      events.push('system-topics');
      return {
        rtcTopologyWorkPublisher: null,
        stop: () => {
          events.push('stop-system-topics');
        },
      };
    },
    createCrdtMutationIngress: () => {
      events.push('crdt-ingress');
      return {} as ReturnType<ApiV1SystemInstallerOperations['createCrdtMutationIngress']>;
    },
    installCrdtTopics: () => {
      events.push('crdt-topics');
      return {
        topicIds: [],
        definitions: [],
        unsubscribeHandlers: () => {},
      };
    },
    initWebSocketLifecycle: () => ({
      getPendingCloseCount: () => 0,
      retryPending: () => Promise.resolve(),
      stop: () => {},
    }),
    scheduleWebSocketLifecycleRetry: () => () => {},
  };
}
