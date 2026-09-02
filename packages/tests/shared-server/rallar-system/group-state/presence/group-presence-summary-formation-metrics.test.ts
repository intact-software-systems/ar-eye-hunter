import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { computeGroupPresenceSummaryEntry, type GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { createAppInboxTestDatabase, type AppInboxTestDatabase } from '../../app-inbox/test-support/app-inbox-test-database.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { TestResourceInbox, TestResourceInboxResults } from '../inbox/group-state-inbox-resource-fixtures.ts';
import { groupRef } from '../mutation/group-mutation-test-runtime.ts';
import { seedOpenGroup } from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = 1_900_000_000_000;

interface RecordedFormationEvent {
    readonly downstreamTopicIds: readonly string[];
    readonly committedOutboxEntries: number;
}

interface FormationScenario {
    readonly worker: GroupPresenceSummaryWork;
    readonly database: AppInboxTestDatabase;
    readonly queue: TestResourceInbox;
    readonly runtime: GroupBarrierRepository;
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly effects: string[];
    readonly formationEvents: RecordedFormationEvent[];
}

describe('GroupPresenceSummaryWork formation metrics', () => {
    it('records one summary expansion metric only after the transaction commits', async () => {
        const scenario = await createFormationScenario(false);

        await scenario.worker.processReservedEntry(scenario.message, scenario.entry);

        expect(scenario.effects).toEqual(['wake', 'metric']);
        expect(scenario.formationEvents).toEqual([{
            downstreamTopicIds: [AppTopics.groupStateEvent, APP_OUTBOX_RTC_TOPOLOGY_TOPIC],
            committedOutboxEntries: 2
        }]);
        expect((await scenario.queue.getItem(scenario.entry.key))?.status).toBe(EntityStatus.COMPLETED);
    });

    it('records no summary expansion metric or wake after a late reservation failure', async () => {
        const scenario = await createFormationScenario(false);
        await scenario.queue.enqueue({
            ...scenario.entry,
            dequeueAudit: { ...scenario.entry.dequeueAudit, attempts: 2 }
        });
        const before = new Map(scenario.runtime.data);

        await expect(scenario.worker.processReservedEntry(scenario.message, scenario.entry))
            .rejects.toThrow('Presence-summary reservation changed before commit');

        expect(scenario.effects).toEqual([]);
        expect(scenario.formationEvents).toEqual([]);
        expect(scenario.database.outboxEntries.size).toBe(0);
        expect(scenario.runtime.data).toEqual(before);
    });

    it('does not turn committed success into failure when the optional metrics sink throws', async () => {
        const scenario = await createFormationScenario(true);

        await scenario.worker.processReservedEntry(scenario.message, scenario.entry);

        expect(scenario.effects).toEqual(['wake', 'metric']);
        expect(scenario.database.outboxEntries.size).toBe(2);
        expect((await scenario.queue.getItem(scenario.entry.key))?.status).toBe(EntityStatus.COMPLETED);
    });
});

async function createFormationScenario(throwFromMetrics: boolean): Promise<FormationScenario> {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, 'summary-group');
    const entry = await createCanonicalReservation(runtime);
    const queue = new TestResourceInbox();
    await queue.enqueue(entry);
    const database = createAppInboxTestDatabase(queue, new TestResourceInboxResults(), { runtimeRepository: runtime });
    const effects: string[] = [];
    const formationEvents: RecordedFormationEvent[] = [];
    const worker = new GroupPresenceSummaryWork({
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        recomputeDebounceMs: 0,
        runtimeRepository: runtime,
        database,
        serviceId: 'summary-handler',
        wakeQueue: () => {
            effects.push('wake');
        },
        now: () => BASE_EPOCH_MS,
        formationMetrics: (event) => {
            effects.push('metric');
            formationEvents.push({ ...event, committedOutboxEntries: database.outboxEntries.size });
            if (throwFromMetrics) {
                throw new Error('Metrics unavailable');
            }
        }
    });
    return {
        worker,
        database,
        queue,
        runtime,
        entry,
        message: decodePersistedALMessage(entry.resource),
        effects,
        formationEvents
    };
}

async function createCanonicalReservation(runtime: GroupBarrierRepository): Promise<ResourceEntry> {
    const ref = groupRef('summary-group');
    const event = (await createTestGroupStateRepository(runtime).listEvents(ref)).at(-1);
    if (!event) {
        throw new Error('Expected group creation event');
    }
    const work: GroupPresenceSummaryWorkData = {
        effectKind: 'group-presence-summary',
        aggregateRef: ref,
        commandId: 'summary-command',
        createdAtEpochMs: event.occurredAtEpochMs,
        expireAtEpochMs: 253_402_300_799_999,
        acceptedCausalRevision: event.causalRevision,
        event
    };
    return {
        ...computeGroupPresenceSummaryEntry(work, 'summary-handler'),
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1, startTs: Temporal.Instant.fromEpochMilliseconds(BASE_EPOCH_MS) }
    };
}
