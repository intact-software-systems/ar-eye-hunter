import { Temporal } from '@js-temporal/polyfill';

import {
    AppInboxType,
    type AppInboxEnqueueInput,
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
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import { createAutoAuthorizingClientStateService } from './app-client-inbox-mutation-test-harness.ts';
import { TestResourceInboxResults } from './app-client-inbox-resource-fixtures.ts';

const SCOPE: StateScope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

interface ClientMutationTransactionBoundaryOptions {
    readonly failTransaction?: boolean;
}

interface ClientMutationTransactionBoundaryFixture {
    readonly actions: string[];
    readonly computedSnapshots: ClientSnapshot[];
    readonly context: AppInboxMessageContext<ClientStateWritten>;
    readonly handler: ClientStateInboxHandler;
    readonly observedSnapshots: ClientSnapshot[];
    readonly results: TestResourceInboxResults;
}

export async function createClientMutationTransactionBoundaryFixture(
    options: ClientMutationTransactionBoundaryOptions = {}
): Promise<ClientMutationTransactionBoundaryFixture> {
    const actions: string[] = [];
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
        mutationService: observeMutationWrites(durable, { actions, computedSnapshots }),
        sessionGenerationLifecycle: durable.sessionGenerationLifecycle,
        expiryCandidates: durable,
        snapshotObserver: {
            observeSnapshot: async (snapshot) => {
                actions.push('observe');
                observedSnapshots.push(snapshot);
                return snapshot;
            }
        },
        transactionWriter: new AppInboxTransactionWriter({ database }, {
            serviceId: 'client-inbox-service',
            nowEpochMs: () => context.message.id.ts
        }),
        serviceId: 'client-inbox-service'
    });
    return { actions, computedSnapshots, context, handler, observedSnapshots, results };
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
        ...durable,
        compute: (command, read) => {
            const computed = durable.compute(command, read);
            if (computed.outcome !== 'idempotency-conflict') {
                effects.computedSnapshots.push(computed.snapshot);
            }
            return computed;
        },
        write: async (transaction, computed) => {
            effects.actions.push('write');
            return await durable.write(transaction, computed);
        }
    };
}

function createReservedClientContext(): AppInboxMessageContext<ClientStateWritten> {
    const now = Date.now();
    const enqueue: AppInboxEnqueueInput = {
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
            id: { v: 2, msgId: 'client-transaction-result', ts: now, senderId: 'alice' },
            route: { ...entry.key },
            payload: { typeId: enqueue.type, contentType: 'application/json', resource: entry.resource }
        },
        entry,
        encodeResult: (result) => encodeAppInboxResult(result, 'Client transaction test result')
    };
}
