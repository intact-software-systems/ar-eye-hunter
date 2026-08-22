import assert from 'node:assert/strict';

import type { ClientRestSnapshotReadSelector } from '@shared-server/rallar-system/client-state/snapshot/client-rest-snapshot-read-selector.ts';
import type { GroupRestSnapshotReadSelector } from '@shared-server/rallar-system/group-state/snapshot/group-rest-snapshot-read-selector.ts';
import type { RallarMiddlewareRuntime } from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import type { ApiRtcTopologyRuntime } from '../../src/runtime/rtc-topology/create-api-rtc-topology-runtime.ts';

import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import type { ApiV1MutationRuntime } from '../../src/composition/create-api-v1-mutation-runtime.ts';
import { constructApiV1Runtime, type ApiV1RuntimeConstructionOperations, type CreateApiV1RuntimeInput } from '../../src/composition/create-api-v1-runtime.ts';
import { toResilienceDto } from '../../src/middleware-resilience.ts';

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
        'register:rtc-stop',
        'configure-ws',
        'resource-expiry',
        'runtime-state-expiry',
        'middleware',
        'attach-replay',
        'scalar-worker',
        'register:scalar-stop',
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
        'register:rtc-stop',
        'configure-ws',
        'resource-expiry',
        'runtime-state-expiry',
        'middleware'
    ]);
});

const MUTATION_RUNTIME = {} as ApiV1MutationRuntime;
const SHARED_RUNTIME = {
    qboxEngine: { wake: () => {} },
    appClientInboxService: {},
    appGroupInboxService: {}
} as RallarMiddlewareRuntime;
const COMPLETE_RUNTIME = {} as ApiV1Runtime;

function createInput(events: string[]): CreateApiV1RuntimeInput {
    return {
        database: Object.assign(() => Promise.resolve([]), {
            begin: () => Promise.reject(new Error('not used'))
        }),
        serviceId: 'api-test',
        publisherStreamId: 'stream-test',
        queuePubSubPublisherId: 'publisher-test',
        queuePubSubChannel: 'channel-test',
        wsRuntimeName: 'ws-test',
        authCredentialSecret: 'a'.repeat(32),
        nowEpochMs: () => 1_000,
        timing: () => {},
        appInboxOptions: { nowEpochMs: () => 1_000 },
        clientFormationDamping: 'damped',
        groupCapacity: { defaultMaxMembers: 10 },
        groupStateDissemination: 'delta-primary',
        createGroupFormationTopologyIntent: () => ({ damping: 'legacy' }),
        databasePubSub: { mode: 'disabled' },
        rtcTopologyReplayMode: 'disabled',
        adminClientIds: ['admin'],
        crdtPolicies: undefined,
        resilience: {
            inbox: toResilienceDto(),
            outbox: toResilienceDto(),
            appOutbox: toResilienceDto()
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
            register: (stop) => {
                events.push(stop === RTC_STOP ? 'register:rtc-stop' : 'register:scalar-stop');
                return () => {};
            },
            stop: () => Promise.resolve()
        }
    };
}

const RTC_STOP = () => Promise.resolve();
const SCALAR_STOP = () => {};

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
        configureWsRuntimeStores: () => record('configure-ws'),
        startResourceInboxExpiry: () => record('resource-expiry'),
        startRuntimeStateExpiry: () => record('runtime-state-expiry'),
        createMiddleware: () => {
            record('middleware');
            return SHARED_RUNTIME;
        },
        createScalarRecomputeWorker: () => {
            record('scalar-worker');
            return { stop: SCALAR_STOP, firstRun: Promise.resolve(0) };
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
