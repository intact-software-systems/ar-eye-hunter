import { Temporal } from '@js-temporal/polyfill';

import { AppInboxType, type AppInboxExecutionMetadata } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import {
    ClientStateInboxHandler,
    type ClientStateInboxHandlerDependencies
} from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts';
import { toClientMutationIssuedSessionAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createAppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import { TestResourceInboxResults } from './app-client-inbox-resource-fixtures.ts';
import { emptyRead } from './client-mutation-compute-test-fixtures.ts';

const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' } as const;

interface HandlerHarness {
    readonly actions: string[];
    readonly writtenSnapshots: ClientSnapshot[];
    readonly context: AppInboxExecutionMetadata;
    readonly handler: ClientStateInboxHandler;
    readonly observedSnapshots: ClientSnapshot[];
    readonly results: TestResourceInboxResults;
}

export async function createHandlerHarness(options: Readonly<{ failTransaction?: boolean; }> = {}): Promise<HandlerHarness> {
    const actions: string[] = [];
    const writtenSnapshots: ClientSnapshot[] = [];
    const observedSnapshots: ClientSnapshot[] = [];
    const queue = new InMemoryQueueBox();
    const results = new TestResourceInboxResults();
    const context = createReservedClientContext();
    await queue.enqueue(context.entry);
    const database = createAppInboxTestDatabase(queue, results, {
        withTransaction: async (write) => {
            actions.push('transaction');
            if (options.failTransaction) {
                throw new Error('injected transaction failure');
            }
            const result = await write();
            actions.push('commit');
            return result;
        }
    });
    const transactionWriter = new AppInboxTransactionWriter({ database }, {
        serviceId: 'client-inbox-service',
        nowEpochMs: () => {
            actions.push('completion-clock');
            return 1_700_000_000_000;
        }
    });
    const handler = new ClientStateInboxHandler({
        mutationService: createClientMutationTestPort(actions, writtenSnapshots),
        mutationTiming: {
            serviceId: 'client-inbox-service',
            sink: (event) => {
                actions.push(event.operation);
            }
        },
        sessionGenerationLifecycle: {
            read: async () => {
                throw new Error('Unexpected WebSocket read');
            },
            write: async () => {
                throw new Error('Unexpected WebSocket write');
            }
        },
        expiryCandidates: { listExpiredSessionCandidates: async () => [] },
        snapshotObserver: {
            observeSnapshot: async (snapshot) => {
                actions.push('observe');
                observedSnapshots.push(snapshot);
                return snapshot;
            }
        },
        transactionWriter,
        serviceId: 'client-inbox-service'
    });
    return { actions, writtenSnapshots, context, handler, observedSnapshots, results };
}

function createClientMutationTestPort(
    actions: string[],
    writtenSnapshots: ClientSnapshot[]
): ClientStateInboxHandlerDependencies['mutationService'] {
    return {
        read: async (command) => {
            actions.push('read');
            return emptyRead(command);
        },
        write: async (_transaction, computed) => {
            actions.push('write');
            writtenSnapshots.push(computed.snapshot);
            return computed.receipt;
        }
    };
}

function createReservedClientContext(): AppInboxExecutionMetadata {
    const enqueue = {
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
                issuedAtEpochMs: 1_699_999_000_000,
                expiresAtEpochMs: 1_700_001_000_000
            },
            SCOPE,
            'upsertPrincipal'
        )
    };
    const entry: ResourceEntry = {
        key: {
            topicId: enqueue.topicId,
            resourceId: enqueue.resourceId,
            contextId: enqueue.contextId
        },
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
            id: { v: 2, ts: 1_700_000_000_000, msgId: 'client-transaction-result', senderId: 'alice' },
            route: entry.key,
            payload: { typeId: enqueue.type, contentType: 'application/json', resource: entry.resource }
        },
        entry
    };
}
