import assert from 'node:assert/strict';

import { RallarServerWsFacade } from '@shared-server/rallar-facade/ws-topic-router.ts';
import type { RallarWsLifecycleHandlers } from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
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

Deno.test('system topic reinstall unregisters and stops the prior owner', () => {
    const events: string[] = [];
    const runtime = createRuntime(events);
    const installers = constructApiV1SystemInstallers(
        createInput(),
        createOperations(events)
    );
    const ws = new RallarServerWsFacade(runtime.wsQBoxServerService);

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
        'crdt-topics'
    ]);
});

Deno.test('system topics fail after topic ownership when CRDT ingress is absent', () => {
    const events: string[] = [];
    const runtime = createRuntime(events, false);
    const installers = constructApiV1SystemInstallers(
        createInput(),
        createOperations(events)
    );

    assert.throws(
        () =>
            installers.installDefaultMiddlewareTopics?.(
                runtime,
                new RallarServerWsFacade(runtime.wsQBoxServerService)
            ),
        /CRDT websocket topics require AppInbox mutation ingress/
    );
    assert.deepEqual(events, ['system-topics', 'register-stop']);
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
            new RallarServerWsFacade(runtime.wsQBoxServerService)
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
    clientDisconnect?: unknown;
    groupCleanup?: unknown;
}

function createInput(): CreateApiV1SystemInstallersInput<ApiV1SystemInstallerTopology> {
    return {
        database: Object.assign(() => Promise.resolve([]), {
            begin: () => Promise.reject(new Error('not used'))
        }),
        serviceId: 'api-test',
        nowEpochMs: () => 1_000,
        topology: {
            rtcTopologyService: {},
            rtcTopologyOptions: {},
            topologyManagement: {},
            topologyConfigRepository: {},
            groupStateRepository: {
                readLifecyclePolicy: rejectUnusedCrdtRead
            },
            topologySnapshotRepository: {},
            rttRepository: {},
            rttRefinementGate: {},
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
        crdtPolicies: undefined,
        globalGraphRecomputeLimit: undefined
    };
}

function rejectUnusedCrdtRead(): Promise<never> {
    return Promise.reject(new Error('CRDT read not used by installer construction test'));
}

function createRuntime(
    events: string[],
    includeCrdt = true,
    calls: RuntimeCalls = new RuntimeCalls()
): ApiV1SystemInstallerRuntime {
    return {
        wsQBoxServerService: new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            new InMemoryQueueBox(new Map()),
            new JsonWebSocketServer(),
            'api-v1-system-installers-test'
        ),
        appClientInboxService: {
            enqueueAuthorisedWsClientDisconnect: (input) => {
                calls.clientDisconnect = input;
                events.push('client-disconnect');
                return Promise.resolve(toResourceEntry('test-client-disconnect', input));
            }
        },
        appGroupInboxService: {
            enqueueGroupSessionCleanup: (input) => {
                calls.groupCleanup = input;
                events.push('group-cleanup');
                return Promise.resolve(0);
            },
            enqueueRtcRtt: () => Promise.reject(new Error('RTC RTT enqueue not used')),
            enqueueFormationCriterionCommand: () => Promise.reject(new Error('formation criterion enqueue not used'))
        },
        appCrdtInboxService: includeCrdt ? {} : undefined,
        backgroundTasks: {
            register: () => {
                events.push('register-stop');
                return () => events.push('unregister-stop');
            }
        },
        groupStateService: {
            observeSnapshot: (snapshot) => Promise.resolve(snapshot),
            readSnapshotAtLeast: () => Promise.resolve(undefined)
        },
        clientStateService: { observeSnapshot: (snapshot) => Promise.resolve(snapshot) },
        outboxQueueReader: {},
        qboxEngine: { wake: () => {} },
        rtcTopologyReplay: { wake: () => {} },
        rtcTopologyExecutionRepository: {},
        rtcTopologyDelivery: {}
    };
}

function createOperations(
    events: string[]
): ApiV1SystemInstallerOperations<ApiV1SystemInstallerRuntime, ApiV1SystemInstallerTopology> {
    return {
        initialiseSystemTopics: () => {
            events.push('system-topics');
            return {
                rtcTopologyWorkPublisher: null,
                stop: () => {
                    events.push('stop-system-topics');
                }
            };
        },
        createCrdtMutationIngress: () => {
            events.push('crdt-ingress');
            return { enqueueUpdate: () => Promise.resolve() };
        },
        installCrdtTopics: () => {
            events.push('crdt-topics');
            return {
                topicIds: [],
                definitions: [],
                unsubscribeHandlers: () => {}
            };
        },
        initWebSocketLifecycle: () => ({
            getPendingCloseCount: () => 0,
            retryPending: () => Promise.resolve(),
            stop: () => {}
        }),
        scheduleWebSocketLifecycleRetry: () => () => {}
    };
}
