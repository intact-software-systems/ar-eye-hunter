import {
    describe,
    expect,
    it
} from 'vitest';

import { computeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import {
    computeGroupStateDeltaEnvelope,
    type GroupPresenceSummaryComputedWork,
    type GroupPresenceSummaryWorkRead
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService, summaryReservationRead } from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

describe('group presence summary delta emission', () => {
    it('emits only the canonical envelope event row', async () => {
        const result = await computeSummaryWork(await createConnectedScenario('emit-delta-row'));

        expect(topicIds(result.computed.downstreamOutboxWrites.map((write) => write.entry))).toEqual([
            AppTopics.groupStateEvent
        ]);
        const eventRow = result.computed.downstreamOutboxWrites[0]?.entry;
        if (eventRow === undefined) {
            throw new Error('Expected emitted group state event row');
        }
        expect(decodePersistedALMessage(eventRow.resource).id.msgId).toContain(
            ':member-state:delta-envelope:'
        );
        expect(readEventRowPayload(eventRow)).toEqual(
            computeGroupStateDeltaEnvelope({
                event: result.command.event,
                summary: result.computed.summary,
                summaryPredecessorCausalRevision: result.read.presence.current?.value.causalRevision ?? null,
                snapshot: result.computed.snapshot
            })
        );
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
            const { work, command, read, computed } = await computeSummaryWork(scenario);

            expect(() => work.validate(command, read, computed)).not.toThrow();

            const tampered: GroupPresenceSummaryComputedWork = {
                ...computed,
                downstreamOutboxWrites: [
                    computeAppOutboxInsert(
                        tamperEventRowEnvelope(computed.downstreamOutboxWrites[0]?.entry, tamper)
                    ),
                    ...computed.downstreamOutboxWrites.slice(1)
                ]
            };
            expect(() => work.validate(command, read, tampered)).toThrow(
                'Presence-summary downstream outbox writes are not canonical'
            );
        }
    );

    it('rejects altered outbox persistence and reservation-finish fields', async () => {
        const { work, command, read, computed } = await computeSummaryWork(
            await createConnectedScenario('emit-tampered-persistence')
        );
        const outboxWrite = computed.downstreamOutboxWrites[0];
        if (outboxWrite === undefined) {
            throw new Error('Expected computed downstream outbox write');
        }

        expect(() =>
            work.validate(command, read, {
                ...computed,
                downstreamOutboxWrites: [{
                    ...outboxWrite,
                    createdAt: '2000-01-01T00:00:00.000Z'
                }]
            })
        ).toThrow('Presence-summary downstream outbox writes are not canonical');
        expect(() =>
            work.validate(command, read, {
                ...computed,
                reservationFinish: {
                    ...computed.reservationFinish,
                    expectedAttempts: computed.reservationFinish.expectedAttempts + 1
                }
            })
        ).toThrow('Presence-summary reservation finish differs from its read facts');
    });
});

interface ConnectedScenario {
    readonly runtime: GroupBarrierRepository;
    readonly groupId: string;
}

async function createConnectedScenario(groupId: string): Promise<ConnectedScenario> {
    const runtime = new GroupBarrierRepository();
    const service = createService(runtime, BASE_EPOCH_MS);
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

interface ComputedSummaryScenario {
    readonly work: GroupPresenceSummaryWork;
    readonly command: GroupPresenceSummaryWorkData;
    readonly read: GroupPresenceSummaryWorkRead;
    readonly computed: GroupPresenceSummaryComputedWork;
}

async function computeSummaryWork(scenario: ConnectedScenario): Promise<ComputedSummaryScenario> {
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
    const read = await work.read(
        command,
        summaryReservationRead(command.commandId),
        BASE_EPOCH_MS + 1_000
    );
    const computed = work.compute(command, read);
    work.validate(command, read, computed);
    return { work, command, read, computed };
}

function topicIds(entries: readonly ResourceEntry[]): readonly string[] {
    return entries.map((entry) => entry.key.topicId);
}

function readEventRowPayload(entry: ResourceEntry): GroupStateDeltaEnvelope {
    const message = decodePersistedALMessage(entry.resource);
    const envelope: unknown = JSON.parse(message.payload.resource);
    validateGroupStateDeltaEnvelope(envelope);
    return envelope;
}

function tamperEventRowEnvelope(
    entry: ResourceEntry | undefined,
    tamper: (envelope: GroupStateDeltaEnvelope) => GroupStateDeltaEnvelope
): ResourceEntry {
    if (entry === undefined) {
        throw new Error('Expected emitted group state event row');
    }
    const message = decodePersistedALMessage(entry.resource);
    const envelope = readEventRowPayload(entry);
    const tamperedMessage: ALMessage = {
        ...message,
        payload: {
            ...message.payload,
            resource: JSON.stringify(tamper(envelope))
        }
    };
    return { ...entry, resource: JSON.stringify(tamperedMessage) };
}
