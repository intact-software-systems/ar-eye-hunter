import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EntityStatus, InMemoryQueueBox, type ALMessage } from '@shared/mod.ts';
import type {
  GroupPresenceSummary,
  GroupRef,
  GroupSnapshot,
  GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { VivaldiNodeData } from '@shared-graph/graph/vivaldi.ts';
import {
  createRtcTopologyOutboxPublisher,
  createRtcTopologyWorkHandler,
  type RtcTopologyGroupRevisionWork,
  type RtcTopologyRttRefreshWork,
} from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import { GroupTopologyManagementService as ConcreteGroupTopologyManagementService } from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import { toAppQueueKey } from '@shared-server/rallar-system/services/app-inbox-queue-key.ts';
import { RtcRttRefinementGate } from '@shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-gate.ts';
import { RtcRttRefinementService } from '@shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-service.ts';
import {
  toRtcRttMutationReceiptId,
  toRtcRttTopologyOutboxId,
} from '@shared-server/rallar-system/rtc-topology/mutation/rtc-rtt-mutation-identifiers.ts';
import { readRtcTopologyWorkEnvelope } from '@shared-server/rallar-system/topology/replay/rtc-topology-work-codec.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

describe('RTC topology APP_OUTBOX work', () => {
  /*
   * Task 7 coverage migration (18 old direct-handler cases):
   * - 3 authority/causal cases -> 5 pure topology computation and mutation
   *   comparison cases.
   * - 9 replay/corruption cases -> 17 retained immutable-envelope tests plus
   *   the publication repository corruption matrix.
   * - 5 inner-retry/fanout cases -> 3 PGlite replay/collision/fence tests and
   *   ResourceInbox retry-policy tests.
   * - 1 RTT coalescing case -> RTT compute/admission and AppInbox tests.
   */
  it('lets ResourceInbox retry the handler-owned write and reservation-fenced completion transaction', () => {
    const source = readFileSync(
      new URL(
        '../../shared-server/rallar-system/topology/replay/create-rtc-topology-work-handler.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const completionSource = readFileSync(
      new URL(
        '../../shared-server/rallar-system/topology/replay/finish-rtc-topology-work.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const handlerStart = source.indexOf('export function createRtcTopologyWorkHandler');
    const handler = source.slice(handlerStart);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handler).not.toMatch(/waitForRuntimeStateWriteRetry/);
    expect(handler).not.toMatch(/\bfor\s*\([^)]*attempt/);
    expect(handler).toMatch(/runInTransaction/);
    expect(handler).toMatch(/writeTopologyMutation\(\s*transaction/);
    expect(handler).toMatch(/appendOrValidate\(\s*transaction/);
    expect(handler).toMatch(/finishRtcTopologyReservation\(transaction, entry\)/);
    expect(handler.indexOf('writeTopologyMutation')).toBeLessThan(
      handler.indexOf('appendOrValidate'),
    );
    const fencedTransaction = handler.slice(
      handler.indexOf('async function writeRtcTopologyPublicationTransaction'),
    );
    expect(fencedTransaction.indexOf('await write(transaction)')).toBeGreaterThanOrEqual(0);
    expect(fencedTransaction.indexOf('await write(transaction)')).toBeLessThan(
      fencedTransaction.indexOf('finishRtcTopologyReservation(transaction, entry)'),
    );
    expect(completionSource).not.toMatch(/waitForRuntimeStateWriteRetry/);
    expect(completionSource).not.toMatch(/\bfor\s*\([^)]*attempt/);
    expect(completionSource).toMatch(/new ResourceInboxRepository\(transaction\)\.finishReserved/);
    expect(completionSource).toMatch(/throw new RuntimeStateWriteConflictError\(\)/);
  });

  it('keeps each committed group revision as an immutable queue entry', async () => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
      senderId: 'server-a',
      now: () => 100,
    });
    const revision1 = createGroupSnapshot(1);
    const revision2 = createGroupSnapshot(2);

    expect(await runtime.publisher.enqueueForGroupSnapshot(revision1)).toBeUndefined();
    await runtime.publisher.enqueueForGroupSnapshot(revision2);

    const entries = await entriesIn(queue);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => readEnvelope(entry).resourceId).sort()).toEqual([
      expect.stringContaining('group-revision:1'),
      expect.stringContaining('group-revision:2'),
    ]);
    expect(entries.map(readWork)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'group-revision',
          sourceGroupStateRevision: 1,
          groupSnapshot: revision1,
          requestedAtEpochMs: 100,
        }),
        expect.objectContaining({
          kind: 'group-revision',
          sourceGroupStateRevision: 2,
          groupSnapshot: revision2,
          requestedAtEpochMs: 100,
        }),
      ]),
    );
  });

  it('returns the durable winner revision for a mutation-stable resource id', async () => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
      senderId: 'server-a',
      now: () => 100,
    });
    const revision1 = createGroupSnapshot(1);
    const revision2 = createGroupSnapshot(2);
    const deliveryId = 'state-mutation-1:rtc-topology-recompute:snapshot';

    const first = await runtime.publisher.enqueueForStateMutation(revision1, deliveryId);
    const duplicate = await runtime.publisher.enqueueForStateMutation(revision2, deliveryId);

    const entries = await entriesIn(queue);
    expect(entries).toHaveLength(1);
    expect(readWork(entries[0]!)).toMatchObject({
      sourceGroupStateRevision: 1,
      groupSnapshot: revision1,
    });
    expect(first).toEqual({ effectiveSnapshotRevision: 1 });
    expect(duplicate).toEqual({ effectiveSnapshotRevision: 1 });
  });

  it('rejects equal-causal queued and finder authority with different content', async () => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
    });
    const queuedGroup = createGroupSnapshotWithCausalRevision(7, 6);
    const corruptFinderGroup: GroupSnapshot = {
      ...queuedGroup,
      group: {
        ...queuedGroup.group,
        displayName: 'equal tuple but different finder authority',
      },
    };
    await runtime.publisher.enqueueForGroupSnapshot(queuedGroup);
    const [entry] = await entriesIn(queue);
    const runtimeRepository = new FakeRuntimeStateRepository();
    const topologyManagement = new ConcreteGroupTopologyManagementService({
      findGroupSnapshotByRef: () => corruptFinderGroup,
      topologyService: new RallarRtcTopologyService({ now: () => 10 }),
      topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository),
      processRttReader: () => [],
    });
    const handler = createRtcTopologyWorkHandler({
      runtime,
      topologyPlanning: topologyManagement.planningService,
      executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
    });

    await expect(handler.onMessage(JSON.parse(entry!.resource), entry!)).rejects.toMatchObject({
      name: 'StateSnapshotRevisionConflictError',
    });
  });

  it('rejects incomparable queued and finder authority after a lower-bound cache miss', async () => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
    });
    const queuedGroup = createGroupSnapshotWithCausalRevision(2, 1);
    const incomparableFinderGroup = createGroupSnapshotWithCausalRevision(1, 2);
    await runtime.publisher.enqueueForGroupSnapshot(queuedGroup);
    const [entry] = await entriesIn(queue);
    const runtimeRepository = new FakeRuntimeStateRepository();
    const findGroupSnapshotByRef = vi.fn(
      (
        _groupRef: GroupRef,
        options?: Readonly<{
          minCausalRevision?: GroupStateCausalRevision;
        }>,
      ) => (options?.minCausalRevision ? undefined : incomparableFinderGroup),
    );
    const topologyManagement = new ConcreteGroupTopologyManagementService({
      findGroupSnapshotByRef,
      topologyService: new RallarRtcTopologyService({ now: () => 10 }),
      topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository),
      processRttReader: () => [],
    });
    const handler = createRtcTopologyWorkHandler({
      runtime,
      topologyPlanning: topologyManagement.planningService,
      executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
    });

    await expect(handler.onMessage(JSON.parse(entry!.resource), entry!)).rejects.toMatchObject({
      name: 'GroupStateSnapshotIncomparableError',
    });
    expect(findGroupSnapshotByRef).toHaveBeenCalledTimes(2);
  });

  it('prefers durable group authority when cache state masks an incomparable tuple', async () => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
    });
    const queuedGroup = createGroupSnapshotWithCausalRevision(2, 1);
    const durableGroup = createGroupSnapshotWithCausalRevision(1, 2);
    await runtime.publisher.enqueueForGroupSnapshot(queuedGroup);
    const [entry] = await entriesIn(queue);
    const runtimeRepository = new FakeRuntimeStateRepository();
    const groupStateRepository = new GroupStateRepository(runtimeRepository);
    await groupStateRepository.putGroup(durableGroup.group);
    await Promise.all(durableGroup.members.map((member) => groupStateRepository.putMember(member)));
    const presenceSummary: GroupPresenceSummary = {
      applicationId: durableGroup.group.applicationId,
      workspaceId: durableGroup.group.workspaceId,
      groupId: durableGroup.group.groupId,
      causalRevision: durableGroup.causalRevision,
      activePrincipalIds: [],
      activeSessionIds: [],
      activeSessions: [],
      activePrincipalCount: 0,
      activeSessionCount: 0,
      computedAtEpochMs: 10,
    };
    expect(await groupStateRepository.insertPresenceSummary(presenceSummary)).toMatchObject({
      status: 'applied',
    });
    const findGroupSnapshotByRef = vi.fn(() => queuedGroup);
    const topologyManagement = new ConcreteGroupTopologyManagementService({
      findGroupSnapshotByRef,
      groupStateRepository,
      topologyService: new RallarRtcTopologyService({ now: () => 10 }),
      topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository),
      processRttReader: () => [],
    });
    const handler = createRtcTopologyWorkHandler({
      runtime,
      topologyPlanning: topologyManagement.planningService,
      executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
    });

    await expect(handler.onMessage(JSON.parse(entry!.resource), entry!)).rejects.toMatchObject({
      name: 'GroupStateSnapshotIncomparableError',
    });
    expect(findGroupSnapshotByRef).not.toHaveBeenCalled();
  });

  it.each([
    'missing-causal-revision',
    'wrong-sender',
    'wrong-type',
    'invalid-forwarding',
    'invalid-qos-options',
    'invalid-diagnostics',
    'missing-target-workspace',
    'missing-room-broadcast-group-ref',
  ] as const)('rejects %s work before reading mutable authority', async (defect) => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
    });
    const group = createGroupSnapshot(4);
    await runtime.publisher.enqueueForGroupSnapshot(group);
    const [entry] = await entriesIn(queue);
    const message = readStoredALMessage(entry);
    let corruptMessage: ALMessage;
    if (defect === 'wrong-sender') {
      corruptMessage = {
        ...message,
        id: { ...message.id, senderId: 'wrong-server' },
      };
    } else if (defect === 'wrong-type') {
      corruptMessage = {
        ...message,
        payload: { ...message.payload, typeId: 'wrong-work-type' },
      };
    } else if (defect === 'invalid-forwarding') {
      corruptMessage = JSON.parse(
        JSON.stringify({
          ...message,
          forwarding: { fanoutLimit: 0 },
        }),
      );
    } else if (defect === 'invalid-qos-options') {
      corruptMessage = JSON.parse(
        JSON.stringify({
          ...message,
          qos: {
            retry: {
              algo: 'exp-backoff',
              opts: { maxAttempts: -1 },
            },
          },
        }),
      );
    } else if (defect === 'invalid-diagnostics') {
      corruptMessage = JSON.parse(
        JSON.stringify({
          ...message,
          diagnostics: { visitedPeerIds: [''] },
        }),
      );
    } else if (defect === 'missing-target-workspace') {
      corruptMessage = JSON.parse(
        JSON.stringify({
          ...message,
          targets: {
            mode: 'multicast',
            groupRef: {
              applicationId: group.group.applicationId,
              groupId: group.group.groupId,
            },
          },
        }),
      );
    } else if (defect === 'missing-room-broadcast-group-ref') {
      corruptMessage = JSON.parse(
        JSON.stringify({
          ...message,
          targets: {
            mode: 'broadcast',
            scope: 'room',
          },
        }),
      );
    } else {
      const envelope: unknown = JSON.parse(message.payload.resource);
      if (!isUnknownRecord(envelope)) {
        throw new Error('Expected a topology work envelope');
      }
      const data = envelope.data;
      if (!isUnknownRecord(data)) {
        throw new Error('Expected topology work data');
      }
      const groupSnapshot = data.groupSnapshot;
      if (!isUnknownRecord(groupSnapshot)) {
        throw new Error('Expected a topology work group snapshot');
      }
      const { causalRevision: _causalRevision, ...snapshotWithoutCausalRevision } = groupSnapshot;
      corruptMessage = {
        ...message,
        payload: {
          ...message.payload,
          resource: JSON.stringify({
            ...envelope,
            data: {
              ...data,
              groupSnapshot: snapshotWithoutCausalRevision,
            },
          }),
        },
      };
    }
    const runtimeRepository = new FakeRuntimeStateRepository();
    const topologyManagement = new ConcreteGroupTopologyManagementService({
      findGroupSnapshotByRef: () => group,
      topologyService: new RallarRtcTopologyService({ now: () => 10 }),
      topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository),
      processRttReader: () => [],
    });
    const readAuthority = vi.spyOn(
      topologyManagement.planningService,
      'readTopologyPlanningAuthority',
    );
    const handler = createRtcTopologyWorkHandler({
      runtime,
      topologyPlanning: topologyManagement.planningService,
      executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
    });

    await expect(handler.onMessage(corruptMessage, entry)).rejects.toBeInstanceOf(TypeError);
    expect(readAuthority).not.toHaveBeenCalled();
  });

  it('rejects retired RTT group-revision work before reading mutable authority', async () => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
    });
    const group = createGroupSnapshot(4);
    await runtime.publisher.enqueueForGroupSnapshot(group);
    const [entry] = await entriesIn(queue);
    const message = readStoredALMessage(entry);
    const envelope: unknown = JSON.parse(message.payload.resource);
    if (!isUnknownRecord(envelope)) throw new Error('Expected a topology work envelope');
    const resourceId = toRtcRttTopologyOutboxId(
      toRtcRttMutationReceiptId(rtt('session-a', 'session-b', 1)),
      group.group,
      `sha256:${'a'.repeat(64)}`,
    );
    const retiredRttMessage: ALMessage = {
      ...message,
      route: {
        ...message.route,
        resourceId: toAppQueueKey({ ...message.route, resourceId }).resourceId,
      },
      payload: {
        ...message.payload,
        resource: JSON.stringify({ ...envelope, resourceId }),
      },
    };
    const runtimeRepository = new FakeRuntimeStateRepository();
    const topologyManagement = new ConcreteGroupTopologyManagementService({
      findGroupSnapshotByRef: () => group,
      topologyService: new RallarRtcTopologyService({ now: () => 10 }),
      topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository),
      processRttReader: () => [],
    });
    const readAuthority = vi.spyOn(
      topologyManagement.planningService,
      'readTopologyPlanningAuthority',
    );
    const handler = createRtcTopologyWorkHandler({
      runtime,
      topologyPlanning: topologyManagement.planningService,
      executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
    });

    expect(() => readRtcTopologyWorkEnvelope(retiredRttMessage, runtime.workType)).toThrow(
      'RTC topology group-revision work cannot use an RTT durable identity',
    );
    await expect(handler.onMessage(retiredRttMessage, entry)).rejects.toBeInstanceOf(TypeError);
    expect(readAuthority).not.toHaveBeenCalled();
  });

  it('rejects RTT work that combines coalesced metadata with a durable identity', async () => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
    });
    const group = createGroupSnapshot(4);
    await runtime.publisher.enqueueForRtt(group, rtt('session-a', 'session-b', 1), 0);
    const [entry] = await entriesIn(queue);
    const message = readStoredALMessage(entry);
    const envelope: unknown = JSON.parse(message.payload.resource);
    if (!isUnknownRecord(envelope)) throw new Error('Expected a topology work envelope');
    const resourceId = toRtcRttTopologyOutboxId(
      toRtcRttMutationReceiptId(rtt('session-c', 'session-d', 2)),
      group.group,
      `sha256:${'b'.repeat(64)}`,
    );
    const hybridRttMessage: ALMessage = {
      ...message,
      route: {
        ...message.route,
        resourceId: toAppQueueKey({ ...message.route, resourceId }).resourceId,
      },
      payload: {
        ...message.payload,
        resource: JSON.stringify({ ...envelope, resourceId }),
      },
    };
    const runtimeRepository = new FakeRuntimeStateRepository();
    const topologyManagement = new ConcreteGroupTopologyManagementService({
      findGroupSnapshotByRef: () => group,
      topologyService: new RallarRtcTopologyService({ now: () => 10 }),
      topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository),
      processRttReader: () => [],
    });
    const readAuthority = vi.spyOn(
      topologyManagement.planningService,
      'readTopologyPlanningAuthority',
    );
    const handler = createRtcTopologyWorkHandler({
      runtime,
      topologyPlanning: topologyManagement.planningService,
      executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
    });

    expect(() => readRtcTopologyWorkEnvelope(hybridRttMessage, runtime.workType)).toThrow(
      'RTC topology RTT work cannot combine coalesced and durable identity',
    );
    await expect(handler.onMessage(hybridRttMessage, entry)).rejects.toBeInstanceOf(TypeError);
    expect(readAuthority).not.toHaveBeenCalled();
  });

  it('keeps a reserved RTT generation immutable and creates a drainable successor', async () => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
      now: () => 1_000,
    });
    const group = createGroupSnapshot(3);
    const rtt = {
      sessionIdFrom: 'session-a',
      sessionIdTo: 'session-b',
      rttMs: 10,
      createdAtEpochMs: 1_000,
      version: 1,
    };
    await runtime.publisher.enqueueForRtt(group, rtt, 0);
    const reserved = await queue.reserveEntries(
      OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
      new Set([EntityStatus.NEW]),
      1,
    );
    const reservedEntry = [...reserved.values()][0]!;

    await runtime.publisher.enqueueForRtt(
      group,
      { ...rtt, version: 2, createdAtEpochMs: 1_001 },
      0,
    );

    expect(readWork(reservedEntry)).toMatchObject({
      kind: 'rtt-refresh',
      requestedRttVersion: 1,
      requestedAtEpochMs: 1_000,
      groupSnapshot: group,
    });
    const entries = await entriesIn(queue);
    expect(entries).toHaveLength(2);
    expect(
      entries.some(
        (entry) =>
          entry.status === EntityStatus.NEW &&
          (readWork(entry) as RtcTopologyRttRefreshWork).requestedRttVersion === 2,
      ),
    ).toBe(true);
  });

  it('uses collision-safe canonical RTT pair identities for successor resources', async () => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
      now: () => 1_000,
    });
    const group = createGroupSnapshot(3);
    const composed = '\u00e9';
    const decomposed = 'e\u0301';

    await runtime.publisher.enqueueForRtt(group, rtt('reserved-a', 'reserved-b', 1), 0);
    await queue.reserveEntries(
      OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
      new Set([EntityStatus.NEW]),
      1,
    );

    for (const measurement of [
      rtt('a', 'b:c', 1),
      rtt('a:b', 'c', 1),
      rtt(composed, 'z', 1),
      rtt(decomposed, 'z', 1),
      rtt('b:c', 'a', 1),
    ]) {
      await runtime.publisher.enqueueForRtt(group, measurement, 0);
    }

    const resourceIds = (await entriesIn(queue)).map((entry) => readEnvelope(entry).resourceId);
    expect(resourceIds).toHaveLength(5);
    expect(new Set(resourceIds).size).toBe(5);
  });

  it('coalesces RTT work to the newest exact group snapshot and request time', async () => {
    const queue = new InMemoryQueueBox();
    let now = 1_000;
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
      now: () => now,
    });
    const revision1 = createGroupSnapshot(1);
    const revision2 = createGroupSnapshot(2);
    const rtt = {
      sessionIdFrom: 'session-a',
      sessionIdTo: 'session-b',
      rttMs: 10,
      createdAtEpochMs: 1_000,
      version: 1,
    };

    await runtime.publisher.enqueueForRtt(revision1, rtt, 100);
    now = 1_100;
    await runtime.publisher.enqueueForRtt(revision2, { ...rtt, version: 2 }, 100);
    now = 1_200;
    await runtime.publisher.enqueueForRtt(revision2, rtt, 100);

    const [entry] = await entriesIn(queue);
    expect(readWork(entry)).toMatchObject({
      kind: 'rtt-refresh',
      groupSnapshot: revision2,
      requestedGroupStateRevision: 2,
      requestedRttVersion: 2,
      rtt: { ...rtt, version: 2 },
      requestedAtEpochMs: 1_200,
    });
  });

  it('skips sub-threshold RTT work before planning and reuses a qualifying retry decision', async () => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
      now: () => 1_000,
    });
    let predictedDistanceMs = 0;
    const observeRtt = vi.fn(() => {
      predictedDistanceMs += 4;
      return true;
    });
    const refinement = new RtcRttRefinementService({
      gate: new RtcRttRefinementGate({
        minIntervalMs: 0,
        vivaldiDeltaThresholdMs: 10,
      }),
      nowEpochMs: () => 1_000,
      observeRtt,
      readPredictedNodeData: () => predictedNodes(predictedDistanceMs),
    });
    const planned = new Error('planned');
    const readTopologyPlanningAuthority = vi.fn(async () => {
      throw planned;
    });
    const runtimeRepository = new FakeRuntimeStateRepository();
    const handler = createRtcTopologyWorkHandler({
      runtime,
      database: createAppInboxTestDatabase(queue, {
        replace: async (entry) => entry,
      }),
      topologyPlanning: {
        readTopologyPlanningAuthority,
        computeTopologyFromAuthority: vi.fn(),
        observeCommittedTopology: vi.fn(),
        recordTopologyPublication: vi.fn(),
        recordTopologyRebuildSkippedFingerprint: vi.fn(),
      },
      executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
      rttRefinementService: refinement,
    });
    const group = createGroupSnapshot(3);

    for (const version of [1, 2]) {
      const entry = await enqueueAndReserveRtt(queue, runtime, group, version);
      await expect(handler.onMessage(JSON.parse(entry.resource), entry)).resolves.toBeUndefined();
    }
    expect(readTopologyPlanningAuthority).not.toHaveBeenCalled();

    const qualifying = await enqueueAndReserveRtt(queue, runtime, group, 3);
    await expect(handler.onMessage(JSON.parse(qualifying.resource), qualifying)).rejects.toBe(
      planned,
    );
    await expect(handler.onMessage(JSON.parse(qualifying.resource), qualifying)).rejects.toBe(
      planned,
    );
    expect(readTopologyPlanningAuthority).toHaveBeenCalledTimes(2);
    expect(observeRtt).toHaveBeenCalledTimes(3);
  });

  it('claims zero-knob RTT work and reuses its canonical observation on retry', async () => {
    const queue = new InMemoryQueueBox();
    const runtime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: new OutboxQueueReader(queue),
      now: () => 1_000,
    });
    const observeRtt = vi.fn(() => true);
    const refinement = new RtcRttRefinementService({
      gate: new RtcRttRefinementGate({ minIntervalMs: 0, vivaldiDeltaThresholdMs: 0 }),
      nowEpochMs: () => 1_000,
      observeRtt,
      readPredictedNodeData: () => predictedNodes(0),
    });
    const planned = new Error('planned');
    const readTopologyPlanningAuthority = vi.fn(async () => {
      throw planned;
    });
    const handler = createRtcTopologyWorkHandler({
      runtime,
      database: createAppInboxTestDatabase(queue, {
        replace: async (entry) => entry,
      }),
      topologyPlanning: {
        readTopologyPlanningAuthority,
        computeTopologyFromAuthority: vi.fn(),
        observeCommittedTopology: vi.fn(),
        recordTopologyPublication: vi.fn(),
        recordTopologyRebuildSkippedFingerprint: vi.fn(),
      },
      executionRepository: new RtcTopologyExecutionRepository(new FakeRuntimeStateRepository()),
      rttRefinementService: refinement,
    });
    const canonical = await enqueueAndReserveRtt(queue, runtime, createGroupSnapshot(3), 1);
    await expect(handler.onMessage(JSON.parse(canonical.resource), canonical)).rejects.toBe(
      planned,
    );
    await expect(handler.onMessage(JSON.parse(canonical.resource), canonical)).rejects.toBe(
      planned,
    );
    expect(observeRtt).toHaveBeenCalledOnce();
  });
});

async function entriesIn(queue: InMemoryQueueBox) {
  return await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key))).then(
    (entries) => entries.filter((entry) => entry !== undefined),
  );
}

function readWork(entry: {
  resource: string;
}): RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork {
  const message = JSON.parse(entry.resource) as ALMessage;
  const envelope = JSON.parse(message.payload.resource) as {
    data: RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork;
  };
  return envelope.data;
}

function readEnvelope(entry: { resource: string }): {
  resourceId: string;
  data: RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork;
} {
  const message = JSON.parse(entry.resource) as ALMessage;
  return JSON.parse(message.payload.resource);
}

function readStoredALMessage(entry: { resource: string }): ALMessage {
  const parsed: unknown = JSON.parse(entry.resource);
  if (!isUnknownRecord(parsed)) throw new Error('Expected an AL message object');
  const id = parsed.id;
  const route = parsed.route;
  const payload = parsed.payload;
  if (
    !isUnknownRecord(id) ||
    id.v !== 2 ||
    typeof id.msgId !== 'string' ||
    typeof id.ts !== 'number' ||
    typeof id.senderId !== 'string' ||
    !isUnknownRecord(route) ||
    typeof route.topicId !== 'string' ||
    typeof route.resourceId !== 'string' ||
    typeof route.contextId !== 'string' ||
    !isUnknownRecord(payload) ||
    typeof payload.typeId !== 'string' ||
    typeof payload.resource !== 'string'
  ) {
    throw new Error('Expected a valid persisted AL message');
  }
  return {
    id: {
      v: 2,
      msgId: id.msgId,
      ts: id.ts,
      senderId: id.senderId,
    },
    route: {
      topicId: route.topicId,
      resourceId: route.resourceId,
      contextId: route.contextId,
    },
    payload: {
      typeId: payload.typeId,
      resource: payload.resource,
    },
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rtt(sessionIdFrom: string, sessionIdTo: string, version: number) {
  return {
    sessionIdFrom,
    sessionIdTo,
    rttMs: version,
    createdAtEpochMs: version,
    version,
  };
}

async function enqueueAndReserveRtt(
  queue: InMemoryQueueBox,
  runtime: ReturnType<typeof createRtcTopologyOutboxPublisher>,
  group: GroupSnapshot,
  version: number,
) {
  await runtime.publisher.enqueueForRtt(group, rtt('session-a', 'session-b', version), 0);
  const reserved = await queue.reserveEntries(
    OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
    new Set([EntityStatus.NEW]),
    1,
  );
  const entry = [...reserved.values()][0];
  if (!entry) throw new Error('Expected reserved RTC RTT work');
  return entry;
}

function predictedNodes(distanceMs: number): ReadonlyMap<string, VivaldiNodeData> {
  return new Map([
    ['session-a', { id: 'session-a', coords: [0], err: 0.1, rttMs: 0 }],
    ['session-b', { id: 'session-b', coords: [distanceMs], err: 0.1, rttMs: 0 }],
  ]);
}

function createGroupSnapshot(stateRevision: number): GroupSnapshot {
  const applicationId = 'app-1';
  const workspaceId = 'workspace-1';
  const groupId = 'room-1';
  return {
    stateRevision,
    causalRevision: {
      groupRevision: stateRevision,
      presenceRevision: 0,
    },
    group: createTestGroup({
      applicationId,
      workspaceId,
      groupId,
      displayName: groupId,
      activeMemberCount: 1,
      ownerPrincipalId: 'owner',
      snapshotVersion: stateRevision,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 0,
      created: createAuditStamp(1),
      updated: createAuditStamp(stateRevision),
    }),
    members: [
      {
        applicationId,
        workspaceId,
        groupId,
        principalId: 'owner',
        role: 'owner',
        status: 'active',
        joined: createAuditStamp(1),
        updated: createAuditStamp(stateRevision),
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
      },
    ],
    activeSessions: [],
    memberCount: 1,
    onlineMemberCount: 0,
  };
}

function createGroupSnapshotWithCausalRevision(
  groupRevision: number,
  presenceRevision: number,
): GroupSnapshot {
  const stateRevision = groupRevision + presenceRevision;
  const snapshot = createGroupSnapshot(stateRevision);
  return {
    ...snapshot,
    causalRevision: { groupRevision, presenceRevision },
    group: {
      ...snapshot.group,
      snapshotVersion: groupRevision,
      presenceVersion: presenceRevision,
    },
  };
}

function createAuditStamp(atEpochMs: number) {
  return {
    atEpochMs,
    actor: { kind: 'service' as const, serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null,
  };
}
