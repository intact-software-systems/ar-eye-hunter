import { describe, expect, it } from 'vitest';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
  computeGroupStateDeltaEnvelope,
  GroupPresenceSummaryWork,
  type GroupPresenceSummaryComputedWork,
  type GroupPresenceSummaryTopologyIntent,
  type GroupPresenceSummaryWorkRead,
  type GroupStateDisseminationMode,
  validateGroupPresenceSummaryOutboxEntries,
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts';
import { computeGroupStateSyncEntries } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { createService } from './group-presence-test-runtime.ts';
import { SCOPE, groupRef } from '../mutation/group-mutation-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

describe('group presence summary dissemination emission', () => {
  it('emits exactly the historical rows under snapshot-per-change', async () => {
    const scenario = await createConnectedScenario('emit-legacy-rows');

    const { command, computed } = await computeSummaryWork(scenario, 'snapshot-per-change');

    const audience = {
      kind: 'group' as const,
      applicationId: command.aggregateRef.applicationId,
      workspaceId: command.aggregateRef.workspaceId,
      resourceId: command.aggregateRef.groupId,
    };
    const expectedEventEntries = computeGroupStateSyncEntries(
      {
        commandId: command.commandId,
        aggregateRef: command.aggregateRef,
        acceptedCausalRevision: command.acceptedCausalRevision,
        audience,
        createdAtEpochMs: command.createdAtEpochMs,
        expireAtEpochMs: command.expireAtEpochMs,
        effects: [{ effectKind: 'member-state', payloadKind: 'event', payload: command.event }],
      },
      'summary-worker',
    );
    const expectedSnapshotEntries = computeGroupStateSyncEntries(
      {
        commandId: command.commandId,
        aggregateRef: command.aggregateRef,
        acceptedCausalRevision: computed.snapshot.causalRevision,
        audience,
        createdAtEpochMs: computed.summary.summary.computedAtEpochMs,
        expireAtEpochMs: command.expireAtEpochMs,
        effects: [
          { effectKind: 'member-state', payloadKind: 'snapshot', payload: computed.snapshot },
          { effectKind: 'scope-directory', payloadKind: 'snapshot', payload: computed.snapshot },
        ],
      },
      'summary-worker',
    );
    expect(computed.downstreamOutboxEntries).toEqual([
      ...expectedEventEntries,
      ...expectedSnapshotEntries,
    ]);
    expect(readEventRowPayload(computed.downstreamOutboxEntries[0]!)).toEqual(command.event);
  });

  it('keeps both snapshot rows and swaps the event payload for the envelope under dual-emit', async () => {
    const scenario = await createConnectedScenario('emit-dual-rows');

    const legacy = await computeSummaryWork(scenario, 'snapshot-per-change');
    const dual = await computeSummaryWork(scenario, 'dual-emit');

    expect(topicIds(dual.computed.downstreamOutboxEntries)).toEqual([
      AppTopics.groupStateEvent,
      AppTopics.groupStateSnapshot,
      AppTopics.groupDirectorySnapshot,
    ]);
    expect(dual.computed.downstreamOutboxEntries.slice(1)).toEqual(
      legacy.computed.downstreamOutboxEntries.slice(1),
    );
    const eventRow = dual.computed.downstreamOutboxEntries[0]!;
    expect((JSON.parse(eventRow.resource) as ALMessage).id.msgId).toContain(
      ':member-state:delta-envelope:',
    );
    expect(readEventRowPayload(eventRow)).toEqual(
      computeGroupStateDeltaEnvelope({
        event: dual.command.event,
        summary: dual.computed.summary,
        summaryPredecessorCausalRevision: dual.read.presence.current?.value.causalRevision ?? null,
        snapshot: dual.computed.snapshot,
      }),
    );
  });

  it('emits only the envelope event row under delta-primary', async () => {
    const scenario = await createConnectedScenario('emit-delta-primary-rows');

    const dual = await computeSummaryWork(scenario, 'dual-emit');
    const deltaPrimary = await computeSummaryWork(scenario, 'delta-primary');

    expect(deltaPrimary.computed.downstreamOutboxEntries).toEqual([
      dual.computed.downstreamOutboxEntries[0],
    ]);
    expect(topicIds(deltaPrimary.computed.downstreamOutboxEntries)).not.toContain(
      AppTopics.groupStateSnapshot,
    );
    expect(topicIds(deltaPrimary.computed.downstreamOutboxEntries)).not.toContain(
      AppTopics.groupDirectorySnapshot,
    );
  });

  it.each([
    [
      'a tampered audience',
      (envelope: GroupStateDeltaEnvelope) => ({
        ...envelope,
        audienceSessionIds: [...envelope.audienceSessionIds, 'forged-session'],
      }),
    ],
    [
      'tampered counts',
      (envelope: GroupStateDeltaEnvelope) => ({
        ...envelope,
        onlineMemberCount: envelope.onlineMemberCount + 1,
      }),
    ],
  ] as const)(
    'rejects %s through the deterministic recomputation mirror',
    async (_label, tamper) => {
      const scenario = await createConnectedScenario('emit-tampered-envelope');
      const { work, command, read, computed } = await computeSummaryWork(scenario, 'dual-emit');

      expect(() => work.validate(command, read, computed)).not.toThrow();

      const tampered: GroupPresenceSummaryComputedWork = {
        ...computed,
        downstreamOutboxEntries: [
          tamperEventRowEnvelope(computed.downstreamOutboxEntries[0]!, tamper),
          ...computed.downstreamOutboxEntries.slice(1),
        ],
      };
      expect(() => work.validate(command, read, tampered)).toThrow(
        'Presence-summary downstream outbox entries are not canonical',
      );
      expect(() =>
        validateGroupPresenceSummaryOutboxEntries(tampered.downstreamOutboxEntries, {
          work: command,
          summary: computed.summary,
          summaryPredecessorCausalRevision: read.presence.current?.value.causalRevision ?? null,
          snapshot: computed.snapshot,
          audience: {
            kind: 'group',
            applicationId: command.aggregateRef.applicationId,
            workspaceId: command.aggregateRef.workspaceId,
            resourceId: command.aggregateRef.groupId,
          },
          serviceId: 'summary-worker',
          disseminationMode: 'dual-emit',
          includePerCommandTopologyEntry: false,
        }),
      ).toThrow('Presence-summary downstream outbox entries are not canonical');
    },
  );
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
    requestId: `seed-${groupId}`,
  });
  await service.upsertMember(SCOPE, groupId, 'bob', {
    status: 'active',
    actorPrincipalId: 'alice',
    requestId: `activate-${groupId}-bob`,
  });
  await service.connectPresenceSession(SCOPE, groupId, `${groupId}-bob-session`, {
    principalId: 'bob',
    generationId: `${groupId}-bob-generation`,
    actorPrincipalId: 'bob',
    expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
    requestId: `connect-${groupId}-bob`,
  });
  return { runtime, groupId };
}

async function computeSummaryWork(
  scenario: ConnectedScenario,
  disseminationMode: GroupStateDisseminationMode,
): Promise<
  Readonly<{
    work: GroupPresenceSummaryWork;
    command: GroupPresenceSummaryWorkData;
    read: GroupPresenceSummaryWorkRead;
    computed: GroupPresenceSummaryComputedWork;
  }>
> {
  const work = new GroupPresenceSummaryWork({
    topologyIntent: dampedTopologyIntent(),
    disseminationMode,
    runtimeRepository: scenario.runtime,
    now: () => BASE_EPOCH_MS + 1_000,
    serviceId: 'summary-worker',
  });
  const ref = groupRef(scenario.groupId);
  const repository = new GroupStateRepository(scenario.runtime);
  const event = (await repository.listEvents(ref)).find(
    (candidate: GroupEvent) => candidate.eventType === 'session-connected',
  );
  if (!event) throw new Error(`Missing session-connected event: ${scenario.groupId}`);
  const command: GroupPresenceSummaryWorkData = {
    effectKind: 'group-presence-summary',
    aggregateRef: ref,
    commandId: `${scenario.groupId}-command`,
    createdAtEpochMs: event.occurredAtEpochMs,
    expireAtEpochMs: 253_402_300_799_999,
    acceptedCausalRevision: event.causalRevision,
    event,
  };
  const read = await work.read(command);
  const computed = work.compute(command, read);
  work.validate(command, read, computed);
  return { work, command, read, computed };
}

function dampedTopologyIntent(): GroupPresenceSummaryTopologyIntent {
  return {
    damping: 'damped',
    outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
    recomputeDebounceMs: 0,
  };
}

function topicIds(entries: readonly ResourceEntry[]): readonly string[] {
  return entries.map((entry) => entry.key.topicId);
}

function readEventRowPayload(entry: ResourceEntry): unknown {
  const message = JSON.parse(entry.resource) as ALMessage;
  return JSON.parse(message.payload.resource);
}

function tamperEventRowEnvelope(
  entry: ResourceEntry,
  tamper: (envelope: GroupStateDeltaEnvelope) => GroupStateDeltaEnvelope,
): ResourceEntry {
  const message = JSON.parse(entry.resource) as ALMessage;
  const envelope = JSON.parse(message.payload.resource) as GroupStateDeltaEnvelope;
  const tamperedMessage: ALMessage = {
    ...message,
    payload: {
      ...message.payload,
      resource: JSON.stringify(tamper(envelope)),
    },
  };
  return { ...entry, resource: JSON.stringify(tamperedMessage) };
}
