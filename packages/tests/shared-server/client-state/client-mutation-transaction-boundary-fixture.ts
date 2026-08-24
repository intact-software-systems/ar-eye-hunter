import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { type AppInboxMessageContext } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { encodeAppInboxResult } from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/app-inbox-transaction-writer.ts';
import { ClientStateInboxHandler } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { toClientMutationIssuedSessionAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toUpsertPrincipalCommandInput } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, NEVER_EXPIRE_TS, toKeyAsString, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { ClientMutationComputed } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';

const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' } as const;
const EXPECTED_DURABLE_JSON = '{"status":"ok","result":{"right":{"snapshot":{"snapshotVersion":4,"stateRevision":3},' + '"event":{"eventId":"event-4"}}}}';

interface HandlerHarness {
    readonly actions: string[];
    readonly committedSnapshot: object;
    readonly context: AppInboxMessageContext<ClientStateWritten>;
    readonly handler: ClientStateInboxHandler;
    readonly observedSnapshots: object[];
    readonly results: TestResourceInboxResults;
}

export async function createHandlerHarness(options: Readonly<{ failTransaction?: boolean; }> = {}): Promise<HandlerHarness> {
    const actions: string[] = [];
    const observedSnapshots: object[] = [];
    const committedSnapshot = { snapshotVersion: 4, stateRevision: 3 };
    const queue = new InMemoryQueueBox();
    const results = new TestResourceInboxResults();
    const context = createReservedClientContext();
    await queue.enqueue(context.entry);
    const database = createAppInboxTestDatabase(queue, results, {
        withTransaction: async (write) => {
            if (options.failTransaction) {
                throw new Error('injected transaction failure');
            }
            const result = await write();
            actions.push('commit');
            return result;
        }
    });
    const handler = new ClientStateInboxHandler({
        mutationService: {
            read: async () => ({}) as never,
            compute: () =>
                ({
                    outcome: 'write',
                    snapshot: committedSnapshot,
                    event: { eventId: 'event-4' }
                }) as never as ClientMutationComputed,
            validate: () => undefined,
            write: async () => {
                actions.push('write');
                return {} as never;
            }
        },
        sessionGenerationLifecycle: {} as never,
        expiryCandidates: { listExpiredSessionCandidates: async () => [] },
        snapshotObserver: {
            observeSnapshot: async (snapshot) => {
                actions.push('observe');
                observedSnapshots.push(snapshot);
                return snapshot;
            }
        },
        transactionWriter: new AppInboxTransactionWriter({
            database,
            serviceId: 'client-inbox-service',
            nowEpochMs: () => 1_700_000_000_000,
            toTimingDetails: () => ({})
        }),
        serviceId: 'client-inbox-service'
    });
    return { actions, committedSnapshot, context, handler, observedSnapshots, results };
}

function createReservedClientContext(): AppInboxMessageContext<ClientStateWritten> {
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
        message: { id: { ts: 1_700_000_000_000 } } as never,
        entry,
        encodeResult: (result) => encodeAppInboxResult(result, 'Client transaction test result')
    };
}

class TestResourceInboxResults {
    private readonly entries = new Map<string, ResourceEntry>();

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.entries.set(toKeyAsString(entry.key), entry);
        return entry;
    }

    async findByKey(key: ResourceEntry['key']): Promise<ResourceEntry | undefined> {
        return this.entries.get(toKeyAsString(key));
    }
}
