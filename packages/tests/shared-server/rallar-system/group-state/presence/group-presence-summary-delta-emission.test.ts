import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { PRESENCE_SUMMARIES_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import {
    validateGroupPresenceSummaryOutboxEntries,
    type GroupPresenceSummaryComputedWork,
    type GroupPresenceSummaryWorkRead
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { decodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { validateGroupStateDeltaEnvelope, type GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createReservedSummaryEntry, createService } from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

describe('group presence summary delta emission', () => {
    it('computes the exact serialized summary CAS write before validation', async () => {
        const { work, command, read, computed } = await runSummaryWorkPhases(
            await createConnectedScenario('summary-persistence-ready')
        );

        expect(computed.summaryWrite).toEqual({
            namespace: PRESENCE_SUMMARIES_NAMESPACE,
            key: groupStateGroupStorageKey(command.aggregateRef),
            value: JSON.stringify(computed.summary.summary),
            expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString(),
            expectedRevision: read.presence.current?.entry.revision ?? null
        });
        const summaryWrite = computed.summaryWrite;
        if (!summaryWrite) {
            throw new Error('Expected summary write');
        }
        expect(work.validate(command, read, {
            ...computed,
            summaryWrite: { ...summaryWrite, value: '{}' }
        })).toEqual(expect.arrayContaining([expect.objectContaining({ cause: expect.any(TypeError) })]));
    });

    it('emits only the canonical envelope event row', async () => {
        const result = await runSummaryWorkPhases(await createConnectedScenario('emit-delta-row'));

        expect(result.computed.downstreamOutboxWrites.map((write) => write.entry.key.topicId)).toEqual([
            AppTopics.groupStateEvent
        ]);
        const eventRow = result.computed.downstreamOutboxWrites[0]!.entry;
        expect(decodePersistedALMessage(eventRow.resource).id.msgId).toContain(
            ':member-state:delta-envelope:'
        );
        expect(decodeEventRowPayload(eventRow)).toMatchObject({
            event: result.command.event,
            members: [],
            removedMemberPrincipalIds: [],
            removedSessionIds: [],
            activeSessionIds: ['emit-delta-row-bob-session'],
            audienceSessionIds: ['emit-delta-row-bob-session'],
            memberCount: 2,
            onlineMemberCount: 1
        });
    });

    it.each(
        [
            [
                'a tampered audience',
                (envelope: GroupStateDeltaEnvelope) => ({
                    ...envelope,
                    audienceSessionIds: [...envelope.audienceSessionIds, 'forged-session']
                })
            ],
            [
                'tampered counts',
                (envelope: GroupStateDeltaEnvelope) => ({
                    ...envelope,
                    onlineMemberCount: envelope.onlineMemberCount + 1
                })
            ]
        ] as const
    )(
        'rejects %s through the deterministic recomputation mirror',
        async (_label, tamper) => {
            const scenario = await createConnectedScenario('emit-tampered-envelope');
            const { work, command, read, computed } = await runSummaryWorkPhases(scenario);

            expect(work.validate(command, read, computed)).toEqual([]);

            const tampered: GroupPresenceSummaryComputedWork = {
                ...computed,
                downstreamOutboxWrites: [
                    {
                        ...computed.downstreamOutboxWrites[0]!,
                        entry: tamperEventRowEnvelope(computed.downstreamOutboxWrites[0]!.entry, tamper)
                    },
                    ...computed.downstreamOutboxWrites.slice(1)
                ]
            };
            expect(work.validate(command, read, tampered)).toEqual(expect.arrayContaining([expect.objectContaining({ cause: expect.any(TypeError) })]));
            expect(validateGroupPresenceSummaryOutboxEntries(tampered.downstreamOutboxWrites.map((write) => write.entry), {
                work: command,
                summary: computed.summary,
                summaryPredecessorCausalRevision: read.presence.current?.value.causalRevision ?? null,
                snapshot: computed.snapshot,
                audience: {
                    kind: 'group',
                    applicationId: command.aggregateRef.applicationId,
                    workspaceId: command.aggregateRef.workspaceId,
                    resourceId: command.aggregateRef.groupId
                },
                serviceId: 'summary-worker'
            })).toEqual(expect.arrayContaining([expect.objectContaining({ cause: expect.any(TypeError) })]));
        }
    );

    it('rejects tampered coalesced-write and reservation-finalization facts', async () => {
        const scenario = await createConnectedScenario('emit-tampered-write-facts');
        const { work, command, read, computed } = await runSummaryWorkPhases(scenario);

        expect(work.validate(command, read, {
            ...computed,
            coalescedTopologyWork: {
                ...computed.coalescedTopologyWork,
                operation: {
                    kind: 'successor',
                    expectedEntry: computed.coalescedTopologyWork.entryWrite.entry
                }
            }
        })).toEqual(expect.arrayContaining([expect.objectContaining({ cause: expect.any(TypeError) })]));
        expect(work.validate(command, read, {
            ...computed,
            reservationFinish: {
                ...computed.reservationFinish,
                expectedAttempts: computed.reservationFinish.expectedAttempts + 1
            }
        })).toEqual(expect.arrayContaining([expect.objectContaining({ cause: expect.any(TypeError) })]));
    });
});

interface ConnectedScenario {
    readonly runtime: GroupBarrierRepository;
    readonly groupId: string;
}

async function createConnectedScenario(groupId: string): Promise<ConnectedScenario> {
    const runtime = new GroupBarrierRepository();
    const service = createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS });
    await service.createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: `seed-${groupId}`
    });
    await service.upsertMember(SCOPE, groupId, 'bob', {
        status: 'active',
        actorPrincipalId: 'alice',
        requestId: `activate-${groupId}-bob`
    });
    await service.connectPresenceSession(SCOPE, groupId, `${groupId}-bob-session`, {
        principalId: 'bob',
        generationId: `${groupId}-bob-generation`,
        actorPrincipalId: 'bob',
        expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
        requestId: `connect-${groupId}-bob`
    });
    return { runtime, groupId };
}

interface SummaryWorkResult {
    readonly work: GroupPresenceSummaryWork;
    readonly command: GroupPresenceSummaryWorkData;
    readonly read: GroupPresenceSummaryWorkRead;
    readonly computed: GroupPresenceSummaryComputedWork;
}

async function runSummaryWorkPhases(scenario: ConnectedScenario): Promise<SummaryWorkResult> {
    const work = new GroupPresenceSummaryWork({
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        recomputeDebounceMs: 0,
        runtimeRepository: scenario.runtime,
        now: () => BASE_EPOCH_MS + 1_000,
        serviceId: 'summary-worker'
    });
    const ref = groupRef(scenario.groupId);
    const repository = createTestGroupStateRepository(scenario.runtime);
    const event = (await repository.listEvents(ref)).find(
        (candidate: GroupEvent) => candidate.eventType === 'session-connected'
    );
    if (!event) {
        throw new Error(`Missing session-connected event: ${scenario.groupId}`);
    }
    const command: GroupPresenceSummaryWorkData = {
        effectKind: 'group-presence-summary',
        aggregateRef: ref,
        commandId: `${scenario.groupId}-command`,
        createdAtEpochMs: event.occurredAtEpochMs,
        expireAtEpochMs: 253_402_300_799_999,
        acceptedCausalRevision: event.causalRevision,
        event
    };
    const read = await work.read(command, createReservedSummaryEntry(command));
    const computed = work.compute(command, read);
    expect(work.validate(command, read, computed)).toEqual([]);
    return { work, command, read, computed };
}

function decodeEventRowPayload(entry: ResourceEntry): GroupStateDeltaEnvelope {
    const message = decodePersistedALMessage(entry.resource);
    const envelope = decodeJsonWireValue(JSON.parse(message.payload.resource), 'Group-state delta envelope');
    validateGroupStateDeltaEnvelope(envelope);
    return envelope;
}

function tamperEventRowEnvelope(
    entry: ResourceEntry,
    tamper: (envelope: GroupStateDeltaEnvelope) => GroupStateDeltaEnvelope
): ResourceEntry {
    const message = decodePersistedALMessage(entry.resource);
    const envelope = decodeEventRowPayload(entry);
    const tamperedMessage: ALMessage = {
        ...message,
        payload: {
            ...message.payload,
            resource: JSON.stringify(tamper(envelope))
        }
    };
    return { ...entry, resource: JSON.stringify(tamperedMessage) };
}
