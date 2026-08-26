import { Temporal } from '@js-temporal/polyfill';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { computeGroupPresenceSummaryEntry, type GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { describe, expect, it, vi } from 'vitest';
import { createAppInboxTestDatabase } from '../../rallar-system/app-inbox/test-support/app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { TestResourceInbox, TestResourceInboxResults } from '../inbox/group-state-inbox-resource-fixtures.ts';

const BASE_EPOCH_MS = Date.now();

describe('GroupPresenceSummaryWork formation metrics', () => {
    it('records one summary expansion metric only after the transaction commits', async () => {
        const { message, entry } = createCanonicalReservation();
        const queue = new TestResourceInbox();
        await queue.enqueue(entry);
        const database = createAppInboxTestDatabase(queue, new TestResourceInboxResults());
        const formationEvents: Array<Readonly<{ downstreamTopicIds: readonly string[]; }>> = [];
        let wakeCount = 0;
        const worker = new GroupPresenceSummaryWork({
            outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
            recomputeDebounceMs: 0,
            runtimeRepository: new FakeRuntimeStateRepository(),
            database: database as never,
            serviceId: 'summary-handler',
            wakeQueue: () => {
                wakeCount += 1;
            },
            now: () => BASE_EPOCH_MS + 5_000,
            formationMetrics: (event) => {
                formationEvents.push(event);
            }
        });
        vi.spyOn(worker, 'read').mockResolvedValue({} as never);
        vi.spyOn(worker, 'compute').mockReturnValue(
            createComputedWorkWithDownstreamTopics([
                AppTopics.groupStateEvent
            ])
        );
        vi.spyOn(worker, 'validate').mockReturnValue(undefined);
        vi.spyOn(worker, 'write').mockResolvedValue(undefined);

        await worker.processReservedEntry(message, entry);

        expect(formationEvents).toEqual([
            {
                downstreamTopicIds: [
                    AppTopics.groupStateEvent,
                    APP_OUTBOX_RTC_TOPOLOGY_TOPIC
                ]
            }
        ]);
        expect(wakeCount).toBe(1);
    });

    it('records no summary expansion metric when the transaction fails', async () => {
        const { message, entry } = createCanonicalReservation();
        const database = createAppInboxTestDatabase(new TestResourceInbox(), new TestResourceInboxResults());
        const formationEvents: Array<Readonly<{ downstreamTopicIds: readonly string[]; }>> = [];
        const worker = new GroupPresenceSummaryWork({
            outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
            recomputeDebounceMs: 0,
            runtimeRepository: new FakeRuntimeStateRepository(),
            database: database as never,
            serviceId: 'summary-handler',
            now: () => BASE_EPOCH_MS + 5_000,
            formationMetrics: (event) => formationEvents.push(event)
        });
        vi.spyOn(worker, 'read').mockResolvedValue({} as never);
        vi.spyOn(worker, 'compute').mockReturnValue(createComputedWorkWithDownstreamTopics([AppTopics.groupStateEvent]));
        vi.spyOn(worker, 'validate').mockReturnValue(undefined);
        vi.spyOn(worker, 'write').mockResolvedValue(undefined);

        await expect(worker.processReservedEntry(message, entry)).rejects.toThrow('Presence-summary reservation changed before commit');
        expect(formationEvents).toEqual([]);
    });
});

function createComputedWorkWithDownstreamTopics(topicIds: readonly string[]) {
    return {
        downstreamOutboxEntries: topicIds.map((topicId, index) => ({
            key: {
                topicId,
                resourceId: `downstream-${index}`,
                contextId: 'summary-context'
            }
        })),
        coalescedTopologyWork: null
    } as never;
}

interface CanonicalSummaryReservation {
    readonly entry: ResourceEntry;
    readonly message: ALMessage;
}

function createCanonicalReservation(): CanonicalSummaryReservation {
    const work: GroupPresenceSummaryWorkData = {
        effectKind: 'group-presence-summary',
        aggregateRef: {
            applicationId: 'summary-app',
            workspaceId: 'main',
            groupId: 'summary-group'
        },
        commandId: 'summary-command',
        createdAtEpochMs: BASE_EPOCH_MS,
        expireAtEpochMs: BASE_EPOCH_MS + 600_000,
        acceptedCausalRevision: {
            groupRevision: 4,
            presenceRevision: 3
        },
        event: {
            applicationId: 'summary-app',
            workspaceId: 'main',
            groupId: 'summary-group',
            eventId: 'summary-event',
            eventType: 'session-connected',
            snapshotVersion: 4,
            causalRevision: {
                groupRevision: 4,
                presenceRevision: 3
            },
            occurredAtEpochMs: BASE_EPOCH_MS,
            actor: { kind: 'service', serviceId: 'summary-handler' },
            reason: null,
            traceId: null,
            requestId: 'summary-command',
            payload: {}
        }
    };
    const queued = computeGroupPresenceSummaryEntry(work, 'summary-handler');
    const entry: ResourceEntry = {
        ...queued,
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            attempts: 1,
            startTs: Temporal.Instant.fromEpochMilliseconds(BASE_EPOCH_MS + 2_000)
        }
    };
    return {
        entry,
        message: JSON.parse(entry.resource) as ALMessage
    };
}
