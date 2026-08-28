import assert from 'node:assert/strict';

import { installRallarCrdtWsTopics } from '@shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import type { RallarWsLifecycleHandlers } from '@shared-server/rallar-system/websocket/ws-lifecycle-service.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { OnWebSocketServerMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import {
    constructApiV1SystemInstallers,
    type ApiV1SystemInstallerOperations,
    type ApiV1SystemInstallerRuntime,
    type ApiV1SystemInstallerTopology,
    type CreateApiV1SystemInstallersInput
} from '../../src/composition/create-api-v1-system-installers.ts';
import * as wsRoutes from '../../src/routes/ws-routes.ts';
import { rememberAuthorisedWsConnection } from '../../src/runtime/rtc-topology/authorised-ws-connection-registry.ts';

Deno.test('system topic installation rejects a second start before mutating installed owners', () => {
    const events: string[] = [];
    const runtime = createRuntime(events);
    const installers = constructApiV1SystemInstallers(
        createInput(),
        createOperations(events, true)
    );
    const ws = new RallarServerWsRouter(runtime.wsQBoxServerService);

    installers.installSystemTopics(runtime, ws);
    const installedEvents = [
        'topology-app-outbox',
        'chat',
        'signaling',
        'rtc-rtt',
        'crdt-ingress',
        'crdt-topics',
        'router'
    ];
    assert.deepEqual(events, installedEvents);
    assert.equal(runtime.wsQBoxServerService.anyInboxRegistrationCount, 1);

    assert.throws(
        () => installers.installSystemTopics(runtime, ws),
        /system topics already installed/i
    );
    assert.deepEqual(events, installedEvents);
    assert.equal(runtime.wsQBoxServerService.anyInboxRegistrationCount, 1);
});

Deno.test('system topics fail before installation when CRDT ingress is absent', () => {
    const events: string[] = [];
    const runtime = createRuntime(events, false);
    const installers = constructApiV1SystemInstallers(
        createInput(),
        createOperations(events)
    );

    assert.throws(
        () =>
            installers.installSystemTopics(
                runtime,
                new RallarServerWsRouter(runtime.wsQBoxServerService)
            ),
        /CRDT websocket topics require AppInbox mutation ingress/
    );
    assert.deepEqual(events, []);
});

Deno.test(
    'websocket lifecycle preserves translations, retry policy, and stop ownership',
    async () => {
        const events: string[] = [];
        const calls = new RuntimeCalls();
        const runtime = createRuntime(events, true, calls);
        let handlers: RallarWsLifecycleHandlers | undefined;
        const operations: ApiV1SystemInstallerOperations<ApiV1SystemInstallerRuntime, ApiV1SystemInstallerTopology> = {
            ...createOperations(events),
            initWebSocketLifecycle: (_service, input) => {
                events.push('ws-lifecycle');
                handlers = input;
                return {
                    getPendingCloseCount: () => 0,
                    retryPending: () => Promise.resolve(),
                    stop: () => {}
                };
            }
        };
        const installers = constructApiV1SystemInstallers(createInput(), operations);
        installers.installWebSocketLifecycle?.(
            runtime,
            new RallarServerWsRouter(runtime.wsQBoxServerService)
        );

        const close = {
            sessionId: 'session-1',
            generationId: 'generation-1',
            generationStartedAtEpochMs: 100,
            disconnectedAtEpochMs: 200,
            reason: 'closed'
        };
        rememberAuthorisedWsConnection('session-1', 'generation-1', {
            authSession: {
                clientId: 'alice',
                username: 'alice',
                sessionId: 'session-1',
                issuedAtEpochMs: 1,
                expiresAtEpochMs: 10_000
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
            expiresAtEpochMs: 10_000
        });
        await handlers?.enqueueClientSessionDisconnect(close);
        await handlers?.enqueueGroupSessionCleanup(close);

        assert.deepEqual(events, [
            'ws-lifecycle',
            'register-stop',
            'client-disconnect',
            'group-cleanup'
        ]);
        assert.deepEqual(handlers?.retry.delaysMs, [
            ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY.delaysAfterAttemptMs,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxDelayMs
        ]);
        assert.equal(handlers?.hasCloseFacts, wsRoutes.hasAuthorisedWsCloseFacts);
        assert.equal(handlers?.releaseCloseFacts, wsRoutes.releaseAuthorisedWsCloseFacts);
        assert.deepEqual(calls.clientDisconnect, wsRoutes.toAuthorisedWsClientDisconnectInput(close));
        assert.deepEqual(calls.groupCleanup, wsRoutes.toGroupPresenceSessionCleanupInput(close));
    }
);

class RuntimeCalls {
    clientDisconnect?: Parameters<ApiV1SystemInstallerRuntime['appClientInboxService']['enqueueAuthorisedWsClientDisconnect']>[0];
    groupCleanup?: Parameters<ApiV1SystemInstallerRuntime['groupStateInboxService']['enqueueGroupSessionCleanup']>[0];
}

interface TestRuntime extends ApiV1SystemInstallerRuntime {
    readonly wsQBoxServerService: CountingWsQueueBoxServerService;
}

function createInput(): CreateApiV1SystemInstallersInput<ApiV1SystemInstallerTopology> {
    return {
        database: Object.assign(() => Promise.resolve([]), {
            begin: () => Promise.reject(new Error('not used'))
        }),
        serviceId: 'api-test',
        nowEpochMs: () => 1_000,
        topology: {
            rtcTopologyOptions: {},
            topologyQuery: {},
            topologyPlanning: {},
            topologySnapshotRepository: {
                findSnapshot: rejectUnusedCrdtRead
            },
            groupStateRepository: {
                readLifecyclePolicy: rejectUnusedCrdtRead,
                readSnapshot: rejectUnusedCrdtRead
            },
            rttRefinementService: {}
        },
        crdtLogRepository: {
            listAfter: rejectUnusedCrdtRead,
            readSnapshot: rejectUnusedCrdtRead,
            readDocumentMetadata: rejectUnusedCrdtRead,
            listDocuments: rejectUnusedCrdtRead,
            exportDebugBundle: rejectUnusedCrdtRead,
            exportBackupBundle: rejectUnusedCrdtRead,
            verifyIntegrity: rejectUnusedCrdtRead
        },
        crdtPolicies: [{ documentType: '*', rollout: 'disabled' }]
    };
}

function rejectUnusedCrdtRead(): Promise<never> {
    return Promise.reject(new Error('CRDT read not used by installer construction test'));
}

function createRuntime(
    events: string[],
    includeCrdt = true,
    calls: RuntimeCalls = new RuntimeCalls()
): TestRuntime {
    return {
        wsQBoxServerService: new CountingWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(new Map()),
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'api-v1-system-installers-test'
        }),
        appClientInboxService: {
            enqueueAuthorisedWsClientDisconnect: (input) => {
                calls.clientDisconnect = input;
                events.push('client-disconnect');
                return Promise.resolve(toResourceEntry('test-client-disconnect', input));
            }
        },
        groupStateInboxService: {
            enqueueGroupSessionCleanup: (input) => {
                calls.groupCleanup = input;
                events.push('group-cleanup');
                return Promise.resolve(0);
            },
            enqueueFormationCriterionCommand: () => Promise.reject(new Error('formation criterion enqueue not used')),
            enqueueTopologyPublicationCommand: () => Promise.reject(new Error('topology publication enqueue not used'))
        },
        rtcRttInboxService: {
            enqueue: () => Promise.reject(new Error('RTC RTT enqueue not used'))
        },
        appCrdtInboxService: includeCrdt ? {} : undefined,
        backgroundTasks: {
            register: () => {
                events.push('register-stop');
                return () => events.push('unregister-stop');
            }
        },
        groupStateService: {
            readSnapshotAtLeast: () => Promise.resolve(undefined)
        },
        outboxQueueReader: {},
        qboxEngine: { wake: () => {} },
        rtcTopologyReplay: { wake: () => {} },
        rtcTopologyExecutionRepository: {},
        rtcTopologyDelivery: {}
    };
}

function createOperations(
    events: string[],
    useProductionCrdtAndRouter = false
): ApiV1SystemInstallerOperations<ApiV1SystemInstallerRuntime, ApiV1SystemInstallerTopology> {
    return {
        installTopologyAppOutbox: () => {
            events.push('topology-app-outbox');
        },
        installChatTopic: () => {
            events.push('chat');
        },
        installRtcSignalingTopic: () => {
            events.push('signaling');
        },
        installRtcRttTopic: () => {
            events.push('rtc-rtt');
        },
        createCrdtMutationIngress: () => {
            events.push('crdt-ingress');
            return { enqueueUpdate: () => Promise.resolve() };
        },
        installCrdtTopics: (ws, options) => {
            events.push('crdt-topics');
            return useProductionCrdtAndRouter
                ? installRallarCrdtWsTopics(ws, options)
                : {
                    topicIds: [],
                    definitions: [],
                    unsubscribeHandlers: () => {}
                };
        },
        installRouter: (router) => {
            events.push('router');
            if (useProductionCrdtAndRouter) {
                router.install();
            }
        },
        initWebSocketLifecycle: () => ({
            getPendingCloseCount: () => 0,
            retryPending: () => Promise.resolve(),
            stop: () => {}
        }),
        scheduleWebSocketLifecycleRetry: () => () => {}
    };
}

class CountingWsQueueBoxServerService extends WsQueueBoxServerService {
    anyInboxRegistrationCount = 0;

    override onAnyInboxMessageDo(
        id: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>
    ): WsQueueBoxServerService {
        this.anyInboxRegistrationCount += 1;
        return super.onAnyInboxMessageDo(id, callback);
    }
}
