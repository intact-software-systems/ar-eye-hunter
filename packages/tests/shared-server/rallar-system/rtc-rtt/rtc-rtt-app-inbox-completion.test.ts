import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { RtcRttInboxService } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import {
    RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
    RTC_RTT_LATEST_NAMESPACE,
    RTC_RTT_RECEIPTS_NAMESPACE
} from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-runtime-namespaces.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { AppInboxTestDatabaseOptions } from '../app-inbox/test-support/app-inbox-test-database-contracts.ts';
import { createAppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import { createAuthorityHarness, createResilience, type AuthorityHarness } from '../group-state/inbox/group-state-inbox-test-runtime.ts';
import { createRtcTopologyGroupSnapshot } from '../topology/rtc-topology-test-fixtures.ts';

afterEach(() => vi.restoreAllMocks());

describe('RTC RTT atomic AppInbox completion', () => {
    it('reads completion after domain facts and passes a complete result before transaction writes', async () => {
        const phases: string[] = [];
        const harness = await createAuthorityHarness(['alice', 'bob']);
        const runtime = createRuntime(harness, phases, {});
        const readCompletion = AppInboxTransactionWriter.prototype.readCompletionFacts;
        const candidates: Parameters<AppInboxTransactionWriter['writeMutation']>[1][] = [];
        vi.spyOn(AppInboxTransactionWriter.prototype, 'readCompletionFacts').mockImplementation(function (this: AppInboxTransactionWriter, context) {
            phases.push('completion-read');
            return readCompletion.call(this, context);
        });
        const writer = vi.spyOn(AppInboxTransactionWriter.prototype, 'writeMutation');
        harness.runtimeRepository.beforeConditionalWrite = async () => {
            const candidate = writer.mock.calls.at(-1)?.[1];
            if (!candidate) {
                throw new Error('RTT persistence requires a computed completion');
            }
            candidates.push(candidate);
        };
        const entry = await runtime.service.enqueue(rttRequest(harness));
        phases.length = 0;

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect(phases).toEqual(['domain-read', 'completion-read', 'record-committed', 'observe', 'wake', 'metrics']);
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0]!.durableResult).toMatchObject({ accepted: true, updated: true });
        expect(candidates[0]!.reservationFinish).toMatchObject({ expectedAttempts: 1, status: EntityStatus.COMPLETED });
        expect(await harness.queue.getItem(entry.key)).toMatchObject({ status: EntityStatus.COMPLETED });
        const result = await harness.results.findByKey(entry.key);
        expect(JSON.parse(result!.resource)).toEqual(candidates[0]!.encodedResult);
    });

    for (const stage of ['resource-result-replace', 'reservation-finish'] as const) {
        it(`rolls back RTT state and effects on ${stage} failure and recomputes on queue redelivery`, async () => {
            const phases: string[] = [];
            const harness = await createAuthorityHarness(['alice', 'bob']);
            let fail = true;
            const runtime = createRuntime(harness, phases, {
                onStage: (current) => {
                    if (current === stage && fail) {
                        throw new RuntimeStateWriteConflictError();
                    }
                }
            });
            const entry = await runtime.service.enqueue(rttRequest(harness));
            phases.length = 0;
            const reserveEntries = harness.queue.reserveEntries.bind(harness.queue);
            let allowDelivery = true;
            vi.spyOn(harness.queue, 'reserveEntries').mockImplementation(async (...args) => {
                if (!allowDelivery) {
                    return new Map();
                }
                const reserved = await reserveEntries(...args);
                if (reserved.size > 0) {
                    allowDelivery = false;
                }
                return reserved;
            });
            vi.spyOn(console, 'error').mockImplementation(() => undefined);

            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

            expect(phases).toEqual(['domain-read']);
            expect(await harness.results.findByKey(entry.key)).toBeUndefined();
            expect(runtime.database.outboxEntries.size).toBe(0);
            for (const namespace of [RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE, RTC_RTT_LATEST_NAMESPACE, RTC_RTT_RECEIPTS_NAMESPACE]) {
                expect(await harness.runtimeRepository.findAllEntries(namespace)).toEqual([]);
            }
            expect((await harness.queue.getItem(entry.key))?.dequeueAudit.attempts).toBe(1);

            fail = false;
            allowDelivery = true;
            await new Promise((resolve) => setTimeout(resolve, 5));
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

            expect(phases).toEqual(['domain-read', 'domain-read', 'record-committed', 'observe', 'wake', 'metrics']);
            expect(await harness.queue.getItem(entry.key)).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 2 } });
            expect(runtime.database.outboxEntries.size).toBe(1);
            const receipts = await harness.runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE);
            expect(receipts).toHaveLength(1);
            expect(JSON.parse(receipts[0]!.value)).toMatchObject({ attemptCount: 2, outcome: 'accepted' });
        });
    }
});

interface RtcRttCompletionTestRuntime {
    readonly service: RtcRttInboxService;
    readonly database: AuthorityHarness['database'];
}

function createRuntime(
    harness: AuthorityHarness,
    phases: string[],
    options: AppInboxTestDatabaseOptions
): RtcRttCompletionTestRuntime {
    const database = createAppInboxTestDatabase(harness.queue, harness.results, {
        ...options,
        runtimeRepository: harness.runtimeRepository
    });
    const group = createRtcTopologyGroupSnapshot('rtt-room', ['alice-session', 'bob-session']);
    const service = new RtcRttInboxService({
        inboxQueueReader: harness.reader,
        resourceInboxRepository: harness.queue,
        resourceInboxResultsRepository: harness.results,
        database,
        groupStateService: harness.groupStateService,
        mutationDependencies: {
            repository: new RtcRttRepository(harness.runtimeRepository, { now: () => harness.nowEpochMs }),
            outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => phases.push('record-committed') }),
            readPolicyInputs: async () => {
                phases.push('domain-read');
                return {
                    candidateGroups: [{
                        ...group,
                        activeSessions: group.activeSessions.map((session) => ({
                            ...session,
                            expiresAtEpochMs: harness.nowEpochMs + 60_000
                        }))
                    }],
                    overlaySnapshotsByGroupKey: new Map(),
                    degreeLimit: 2
                };
            },
            observeCommitted: () => phases.push('observe'),
            formationMetrics: () => phases.push('metrics')
        }
    }, {
        serviceId: 'rtt-completion-test',
        options: { nowEpochMs: () => harness.nowEpochMs },
        wakeOwningQueue: () => phases.push('wake')
    });
    return { service, database };
}

function rttRequest(harness: AuthorityHarness) {
    return {
        rtt: {
            sessionIdFrom: 'alice-session',
            sessionIdTo: 'bob-session',
            rttMs: 12,
            createdAtEpochMs: harness.nowEpochMs,
            version: 1
        },
        alSenderId: 'alice-session',
        capturedAtEpochMs: harness.nowEpochMs
    };
}
