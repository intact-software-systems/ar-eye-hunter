import { Temporal } from '@js-temporal/polyfill';

import {
    AppInboxType,
    type AppInboxEnqueue,
    type AppInboxMessageContext
} from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { encodeAppInboxResult } from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import type {
    ClientStateMutationService,
    ClientStateWritten
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { ClientStateInboxHandler } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts';
import { toClientMutationIssuedSessionAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { computeResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { TestResourceInboxResults } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { createAutoAuthorizingClientStateService } from './app-client-inbox-mutation-test-harness.ts';
import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from './test-disconnected-session-retention.ts';

const SCOPE: StateScope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

interface ClientMutationTransactionBoundaryOptions {
    readonly failTransaction?: boolean;
    readonly recordMutationTiming?: boolean;
}

interface ClientMutationTransactionBoundaryFixture {
    readonly actions: string[];
    readonly computedSnapshots: ClientSnapshot[];
    readonly context: AppInboxMessageContext<ClientStateWritten>;
    readonly handler: ClientStateInboxHandler;
    readonly observedSnapshots: ClientSnapshot[];
    readonly results: TestResourceInboxResults;
    /** The mutation timing lines, recorded only with `recordMutationTiming`. */
    readonly timing: RallarTimingEvent[];
}

export async function createClientMutationTransactionBoundaryFixture(
    options: ClientMutationTransactionBoundaryOptions = {}
): Promise<ClientMutationTransactionBoundaryFixture> {
    const actions: string[] = [];
    const timing: RallarTimingEvent[] = [];
    const observedSnapshots: ClientSnapshot[] = [];
    const computedSnapshots: ClientSnapshot[] = [];
    const queue = new InMemoryQueueBox();
    const results = new TestResourceInboxResults();
    const runtimeRepository = new FakeRuntimeStateRepository();
    const context = createReservedClientContext();
    await queue.enqueue(context.entry);
    const database = createAppInboxTestDatabase(queue, results, {
        runtimeRepository,
        withTransaction: async (write) => {
            if (options.failTransaction) {
                throw new Error('injected transaction failure');
            }
            const result = await write();
            actions.push('commit');
            return result;
        }
    });
    const durable = createAutoAuthorizingClientStateService(runtimeRepository, database);
    const handler = new ClientStateInboxHandler({
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        mutationService: observeMutationWrites(durable, {
            actions,
            computedSnapshots
        }),
        sessionGenerationLifecycle: durable.sessionGenerationLifecycle,
        expiryCandidates: durable,
        expiryContinuationWriter: { write: async () => undefined },
        snapshotObserver: {
            observeSnapshot: async (snapshot) => {
                actions.push('observe');
                observedSnapshots.push(snapshot);
                return snapshot;
            }
        },
        transactionWriter: new AppInboxTransactionWriter({
            database,
            nowEpochMs: () => {
                actions.push('completion');
                return context.message.id.ts;
            }
        }, { finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS, serviceId: 'client-inbox-service' }),
        mutationTiming: {
            serviceId: 'client-inbox-service',
            sink: options.recordMutationTiming
                ? (event) => {
                    actions.push(event.operation);
                    timing.push(event);
                }
                : undefined
        },
        serviceId: 'client-inbox-service',
        disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS
    });
    return { actions, computedSnapshots, context, handler, observedSnapshots, results, timing };
}

interface ObservedMutationEffects {
    readonly actions: string[];
    readonly computedSnapshots: ClientSnapshot[];
}

function observeMutationWrites(
    durable: ClientStateMutationService,
    effects: ObservedMutationEffects
): ClientStateMutationService {
    return {
        read: durable.read,
        readAuthorisedWsConnect: durable.readAuthorisedWsConnect,
        write: async (transaction, computed) => {
            effects.actions.push('write');
            effects.computedSnapshots.push(computed.snapshot);
            return await durable.write(transaction, computed);
        }
    };
}

function createReservedClientContext(): AppInboxMessageContext<ClientStateWritten> {
    const now = Date.now();
    const enqueue: AppInboxEnqueue = {
        type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        topicId: 'app-inbox.client-state',
        resourceId: 'client-transaction-result',
        contextId: 'ar-eye-hunter/default/alice',
        senderId: 'alice',
        data: {},
        authority: toClientMutationIssuedSessionAuthority(
            {
                clientId: 'alice',
                username: 'alice',
                sessionId: 'alice-session',
                accessTokenDigest: 'sha256:alice-session',
                issuedAtEpochMs: now - 1000,
                expiresAtEpochMs: now + 60_000
            },
            SCOPE,
            'upsertPrincipal'
        )
    };
    const entry: ResourceEntry = {
        key: { topicId: 'app-inbox.client-state', resourceId: 'client-transaction-result', contextId: 'ar-eye-hunter/default/alice' },
        resource: JSON.stringify(enqueue),
        typeId: EnqueuedType.APP_INBOX,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'client-inbox-service',
            createdTs: Temporal.PlainDateTime.from('2026-08-05T12:00:00'),
            expiryTs: NEVER_EXPIRE_TS
        },
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1 }
    };
    return {
        enqueue,
        message: {
            id: { v: 4, msgId: 'client-transaction-result', ts: now, senderId: 'alice', traceId: 'trace-create-client-mutation-transaction-boundary-fixture' },
            route: { ...entry.key },
            payload: { typeId: enqueue.type, contentType: 'application/json', resource: entry.resource }
        },
        entry,
        attemptTelemetry: computeResourceInboxAttempt({
            entry: entry,
            selectedLane: Reservator.NEW,
            selectedAtEpochMs: Number(entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds),
            selectedDueAtEpochMs: undefined,
            reservationLeaseMs: 60_000
        }).telemetry,
        encodeResult: (result) => encodeAppInboxResult(result, 'Client transaction test result')
    };
}
