import assert from 'node:assert/strict';

import type { ClientRestSnapshotReadSelector } from '@shared-server/rallar-system/client-state/snapshot/client-rest-snapshot-read-selector.ts';
import type { GroupRestSnapshotReadSelector } from '@shared-server/rallar-system/group-state/snapshot/group-rest-snapshot-read-selector.ts';
import type { RallarMiddlewareRuntime } from '@shared-server/rallar-system/middleware/rallar-middleware-runtime.ts';
import type { RallarAlmReceiptDiagnosticsRecorder } from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import type { AppInboxCompletionNoticeChannel } from '@shared-server/rallar-system/queue-pubsub/app-inbox-completion-notice.ts';

import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import type { ApiV1MutationRuntime } from '../../src/composition/create-api-v1-mutation-runtime.ts';
import {
    constructApiV1Runtime,
    type ApiV1RuntimeConstructionOperations,
    type CreateApiV1RuntimeInput
} from '../../src/composition/create-api-v1-runtime.ts';
import type { ApiV1TopologyServices } from '../../src/composition/create-api-v1-topology-services.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { createLocalQueuePubSubBus } from '../../src/db/local-queue-pubsub-bridge.ts';
import type { ApiRtcTopologyRuntime } from '../../src/runtime/rtc-topology/create-api-rtc-topology-runtime.ts';
import { createApiTimingSink, toApiOutboxStageTimingSink } from '../../src/services/timing-service.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';

Deno.test('production timing-off configuration omits outbox stage sinks before owner construction', () => {
    const configuration = decodeApiV1Configuration(validDecodeApiV1ConfigurationInput());
    const observability = { ...configuration.observability, timingLogs: false };
    const timing = createApiTimingSink(observability);
    const operations = createOperations([]);
    let mutationStageTiming: CreateApiV1RuntimeInput['outboxStageTiming'];
    let middlewareStageTiming: CreateApiV1RuntimeInput['outboxStageTiming'];
    constructApiV1Runtime({ ...createInput([]), timing, outboxStageTiming: toApiOutboxStageTimingSink(observability, timing) }, {
        ...operations,
        createMutationRuntime: (input) => {
            mutationStageTiming = input.outboxStageTiming;
            return MUTATION_RUNTIME;
        },
        createMiddleware: (input) => {
            middlewareStageTiming = input.outboxStageTiming;
            return SHARED_RUNTIME;
        }
    });
    assert.equal(mutationStageTiming, undefined);
    assert.equal(middlewareStageTiming, undefined);
});

Deno.test('runtime construction preserves the owned startup sequence', () => {
    const events: string[] = [];
    const runtime = constructApiV1Runtime(
        createInput(events),
        createOperations(events)
    );

    assert.equal(runtime, COMPLETE_RUNTIME);
    assert.deepEqual(events, [
        'begin-expiry-generation',
        'mutation',
        'rtc',
        'topology',
        'register:rtc-stop',
        'configure-ws',
        'resource-expiry',
        'runtime-state-expiry',
        'middleware',
        'attach-replay',
        'presence-reconciliation',
        'selectors',
        'require-runtime'
    ]);
});

Deno.test('runtime construction stops at a synchronous ownership failure', () => {
    const events: string[] = [];

    assert.throws(
        () =>
            constructApiV1Runtime(
                createInput(events),
                createOperations(events, 'middleware')
            ),
        /middleware failed/
    );
    assert.deepEqual(events, [
        'begin-expiry-generation',
        'mutation',
        'rtc',
        'topology',
        'register:rtc-stop',
        'configure-ws',
        'resource-expiry',
        'runtime-state-expiry',
        'middleware'
    ]);
});

Deno.test('runtime construction refuses an attempt deadline margin outside the AppInbox lease before any startup step', () => {
    const lease = createInput([]).resilience.inbox.reservationLeaseMs;
    for (const attemptDeadlineMarginMs of [0, lease, lease + 1]) {
        const events: string[] = [];

        assert.throws(
            () =>
                constructApiV1Runtime(
                    { ...createInput(events), appInboxOptions: { nowEpochMs: () => 1_000, attemptDeadlineMarginMs } },
                    createOperations(events)
                ),
            /attempt deadline margin/
        );
        assert.deepEqual(events, []);
    }
});

Deno.test('runtime construction hands one receipt recorder to the middleware and to the admin runtime', () => {
    const operations = createOperations([]);
    const handedRecorders: RallarAlmReceiptDiagnosticsRecorder[] = [];
    constructApiV1Runtime(createInput([]), {
        ...operations,
        createMiddleware: (input) => {
            handedRecorders.push(input.almReceiptDiagnostics);
            return SHARED_RUNTIME;
        },
        requireRuntime: (input) => {
            handedRecorders.push(input.almReceiptDiagnostics);
            return COMPLETE_RUNTIME;
        }
    });

    assert.equal(handedRecorders.length, 2);
    assert.ok(handedRecorders[0]?.readDiagnostics().capacity === 256);
    assert.equal(handedRecorders[0], handedRecorders[1]);
});

Deno.test('runtime construction hands one completion notice channel to the relaying mutation runtime and the middleware', () => {
    const operations = createOperations([]);
    const handed: Array<AppInboxCompletionNoticeChannel | undefined> = [];
    const notification = { notify: () => Promise.resolve(), listen: () => Promise.resolve() };
    for (const databasePubSubMode of ['disabled', 'postgres'] as const) {
        constructApiV1Runtime({ ...createInput([]), databasePubSubMode, databaseNotification: notification }, {
            ...operations,
            createMutationRuntime: (input) => {
                handed.push(input.appInboxCompletionNotices);
                return MUTATION_RUNTIME;
            },
            createMiddleware: (input) => {
                handed.push(input.appInboxCompletionNotices);
                return SHARED_RUNTIME;
            }
        });
    }

    assert.deepEqual(handed.slice(0, 2), [undefined, undefined]);
    assert.ok(handed[2] !== undefined);
    assert.equal(handed[2], handed[3]);
});

const MUTATION_RUNTIME: ApiV1MutationRuntime = {
    groupFormationMetrics: { rttMutation: {} },
    resourceInboxRepository: {
        entries: {
            findByKey: () => Promise.reject(new Error('pending replan not read here'))
        }
    }
} as never;
const SHARED_RUNTIME = {
    qboxEngine: { wake: () => {} },
    appClientInboxService: {},
    topologyInboxService: {}
} as RallarMiddlewareRuntime;
const COMPLETE_RUNTIME = {} as ApiV1Runtime;
const TOPOLOGY_SERVICES = {} as ApiV1TopologyServices;

function createInput(events: string[]): CreateApiV1RuntimeInput {
    return {
        database: Object.assign(() => Promise.resolve([]), {
            begin: () => Promise.reject(new Error('not used'))
        }),
        serviceId: 'api-test',
        publisherStreamId: 'stream-test',
        queuePubSubPublisherId: 'publisher-test',
        queuePubSubChannel: 'channel-test',
        queuePubSubLocalBus: createLocalQueuePubSubBus(),
        wsRuntimeName: 'ws-test',
        authCredentialSecret: 'a'.repeat(32),
        maxConcurrentPasswordDerivations: 1,
        nowEpochMs: () => 1_000,
        timing: () => {},
        appInboxOptions: { nowEpochMs: () => 1_000 },
        appInboxLaneBudgetPolicy: 'fixed-retry-two',
        appInboxNewLaneConcurrency: 1,
        groupCapacity: { defaultMaxMembers: 10 },
        groupFormationRecomputeDebounceMs: 250,
        groupFormationRecomputeMaxWaitMs: 1_000,
        databasePubSubMode: 'disabled',
        databaseNotification: null,
        topologyReplay: {
            mode: 'disabled',
            queueWorkers: 'disabled'
        },
        topologyDelivery: TEST_TOPOLOGY_DELIVERY,
        adminClientIds: ['admin'],
        rtcTopologyOptions: {},
        rttRefinementGateConfig: {
            minIntervalMs: 0,
            vivaldiDeltaThresholdMs: 0
        },
        crdtPolicies: [{ documentType: '*', rollout: 'disabled' }],
        resilience: {
            inbox: createApiV1TestQueueResilience(),
            outbox: createApiV1TestQueueResilience(),
            appOutbox: createApiV1TestQueueResilience()
        },
        backgroundTasks: {
            beginStartupGeneration: () => {
                events.push('begin-expiry-generation');
                return {
                    isCurrent: () => true,
                    startRtcRttReceiptFamilyCleanup: () => Promise.resolve(0),
                    startRuntimeStateExpiryEviction: () => Promise.resolve(0)
                };
            },
            register: () => {
                events.push('register:rtc-stop');
                return () => {};
            },
            stop: () => Promise.resolve()
        }
    };
}
const TEST_TOPOLOGY_DELIVERY: CreateApiV1RuntimeInput['topologyDelivery'] = {
    publicationRetentionMs: 86_400_000,
    heartbeatIntervalMs: 10_000,
    leaseDurationMs: 30_000,
    antiEntropyIntervalMs: 1_000,
    pageSize: 100,
    maxPagesPerTurn: 10,
    maxEntriesPerTurn: 1_000,
    compactionIntervalMs: 60_000,
    compactionPageSize: 1_000,
    reconnectBatchWindowMs: 25,
    consumerRetentionMs: 86_400_000
};

const RTC_STOP = () => Promise.resolve();

function createOperations(
    events: string[],
    failAt?: string
): ApiV1RuntimeConstructionOperations {
    const record = (name: string): void => {
        events.push(name);
        if (name === failAt) {
            throw new Error(`${name} failed`);
        }
    };
    return {
        createMutationRuntime: () => {
            record('mutation');
            return MUTATION_RUNTIME;
        },
        createRtcTopologyRuntime: () => {
            record('rtc');
            return {
                publicationRepository: {} as ApiRtcTopologyRuntime['publicationRepository'],
                executionRepository: {} as ApiRtcTopologyRuntime['executionRepository'],
                topologyDelivery: {} as ApiRtcTopologyRuntime['topologyDelivery'],
                readiness: Promise.resolve(),
                healthFailure: new Promise<never>(() => {}),
                topologyReplay: {
                    attach: () => record('attach-replay'),
                    wake: () => {},
                    readMetrics: () => ({}) as ReturnType<ApiRtcTopologyRuntime['topologyReplay']['readMetrics']>,
                    resetMetrics: () => {}
                },
                stop: RTC_STOP
            };
        },
        createTopologyServices: () => {
            record('topology');
            return TOPOLOGY_SERVICES;
        },
        configureWsRuntimeStores: () => record('configure-ws'),
        startResourceInboxExpiry: () => record('resource-expiry'),
        startRuntimeStateExpiry: () => record('runtime-state-expiry'),
        createMiddleware: () => {
            record('middleware');
            return SHARED_RUNTIME;
        },
        startPresenceReconciliation: () => {
            record('presence-reconciliation');
            return Promise.resolve();
        },
        createSnapshotSelectors: () => {
            record('selectors');
            return {
                clientRestSnapshotReadSelector: {} as ClientRestSnapshotReadSelector,
                groupRestSnapshotReadSelector: {} as GroupRestSnapshotReadSelector
            };
        },
        requireRuntime: () => {
            record('require-runtime');
            return COMPLETE_RUNTIME;
        }
    };
}
