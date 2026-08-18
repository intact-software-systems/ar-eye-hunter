import { describe, expect, it, vi } from 'vitest';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { DEFAULT_RTC_RTT_MUTATION_RETENTION_MS } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-persistence-validation.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts';
import {
  RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
  RTC_RTT_RECEIPTS_NAMESPACE,
} from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-runtime-namespaces.ts';
import {
  toRtcRttMutationReceiptId,
  toRtcRttTopologyOutboxId,
} from '@shared-server/rallar-system/rtc-topology/mutation/rtc-rtt-mutation-identifiers.ts';
import type {
  RtcRttMutationCommand,
  RtcRttMutationComputed,
} from '@shared-server/rallar-system/rtc-topology/mutation/rtc-rtt-mutation-contracts.ts';
import { writeRtcRttMutation } from '@shared-server/rallar-system/rtc-topology/mutation/write-rtc-rtt-mutation.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import {
  hashMutationCommand,
  type JsonWireValue,
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import type { PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';

import { FakeRuntimeStateRepository } from '../../../fake-runtime-state-repository.ts';
import {
  createRttGroupSnapshot,
  createValidRttWriteCandidate,
  executeRtcRttMutation,
  type MutableRttWriteCandidate,
  rttWriteCandidateCorruptions,
} from './rtc-rtt-persistence-test-fixtures.ts';

describe('RTC RTT repository convergence', () => {
  it('optimistically admits only one of two endpoint-cap races', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    vi.spyOn(runtimeRepository, 'lockKey').mockResolvedValue();
    const repository = new RtcRttRepository(runtimeRepository, {
      now: () => 1,
    });
    let waiting = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalList = repository.listMeasurementEntries.bind(repository);
    vi.spyOn(repository, 'listMeasurementEntries').mockImplementation(async () => {
      const values = await originalList();
      waiting += 1;
      if (waiting === 2) release();
      await together;
      return values;
    });
    const groupAB = createRttGroupSnapshot('room-ab', ['session-a', 'session-b']);
    const groupAC = createRttGroupSnapshot('room-ac', ['session-a', 'session-c']);

    const results = await Promise.all([
      executeRtcRttMutation({
        repository,
        runtime: runtimeRepository,
        command: {
          rtt: {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 1,
            createdAtEpochMs: 1,
            version: 1,
          },
          alSenderId: 'session-a',
          candidateGroups: [groupAB],
          overlaySnapshotsByGroupKey: new Map(),
          degreeLimit: 1,
        },
        readFacts: () => ({
          purgeAfterEpochMs: 60_001,
          requestedAtEpochMs: 1,
        }),
        sleep: async () => {},
      }),
      executeRtcRttMutation({
        repository,
        runtime: runtimeRepository,
        command: {
          rtt: {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-c',
            rttMs: 2,
            createdAtEpochMs: 1,
            version: 1,
          },
          alSenderId: 'session-a',
          candidateGroups: [groupAC],
          overlaySnapshotsByGroupKey: new Map(),
          degreeLimit: 1,
        },
        readFacts: () => ({
          purgeAfterEpochMs: 60_001,
          requestedAtEpochMs: 1,
        }),
        sleep: async () => {},
      }),
    ]);

    expect(results.filter((result) => result.updated)).toHaveLength(1);
    expect(await repository.listMeasurements()).toHaveLength(1);
    expect(runtimeRepository.locks).toEqual([]);
  });

  it.each(rttWriteCandidateCorruptions)(
    'rejects $label before opening the RTT write transaction',
    async ({ corrupt }) => {
      const transaction = createUnopenedTransactionSql();
      const begin = vi.spyOn(transaction, 'begin');
      const malformed = corrupt(
        structuredClone(createValidRttWriteCandidate()) as unknown as MutableRttWriteCandidate,
      );

      await expect(
        writeRtcRttMutation(
          transaction,
          { now: () => 2 },
          malformed as unknown as Extract<RtcRttMutationComputed, { outcome: 'write' }>,
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(begin).not.toHaveBeenCalled();
    },
  );

  it.each(['group', 'session-from', 'session-to'] as const)(
    'rejects RTT authority when the candidate %s is expired at attempt time',
    async (expiredAuthority) => {
      const runtimeRepository = new FakeRuntimeStateRepository();
      const repository = new RtcRttRepository(runtimeRepository, {
        now: () => 10,
      });
      const baseGroup = createRttGroupSnapshot(`room-expired-${expiredAuthority}`, [
        'session-a',
        'session-b',
      ]);
      const group =
        expiredAuthority === 'group'
          ? {
              ...baseGroup,
              group: { ...baseGroup.group, expiresAtEpochMs: 10 },
            }
          : {
              ...baseGroup,
              activeSessions: baseGroup.activeSessions.map((session) =>
                session.sessionId ===
                (expiredAuthority === 'session-from' ? 'session-a' : 'session-b')
                  ? { ...session, expiresAtEpochMs: 10 }
                  : session,
              ),
            };
      const command: RtcRttMutationCommand = {
        rtt: {
          sessionIdFrom: 'session-a',
          sessionIdTo: 'session-b',
          rttMs: 1,
          createdAtEpochMs: 1,
          version: 1,
        },
        alSenderId: 'session-a',
        candidateGroups: [group],
        overlaySnapshotsByGroupKey: new Map(),
        degreeLimit: 1,
      };

      await expect(
        executeRtcRttMutation({
          repository,
          runtime: runtimeRepository,
          command,
          readFacts: () => ({
            requestedAtEpochMs: 10,
            purgeAfterEpochMs: 60_010,
          }),
          sleep: async () => {},
        }),
      ).resolves.toMatchObject({
        updated: false,
        computed: {
          outcome: 'rejected',
          reason: 'no-shared-active-group',
        },
      });
      await expect(runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE)).resolves.toEqual(
        [],
      );
    },
  );

  it('reruns RTT lifecycle authority after a CAS conflict crosses group expiry', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new RtcRttRepository(runtimeRepository, {
      now: () => 1,
    });
    const baseGroup = createRttGroupSnapshot('room-retry-expiry', ['session-a', 'session-b']);
    const group = {
      ...baseGroup,
      group: { ...baseGroup.group, expiresAtEpochMs: 2 },
    };
    const command: RtcRttMutationCommand = {
      rtt: {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 1,
        createdAtEpochMs: 1,
        version: 1,
      },
      alSenderId: 'session-a',
      candidateGroups: [group],
      overlaySnapshotsByGroupKey: new Map(),
      degreeLimit: 1,
    };
    const readCommand = vi.fn(() => command);
    const readFacts = vi
      .fn()
      .mockReturnValueOnce({
        requestedAtEpochMs: 1,
        purgeAfterEpochMs: 60_001,
      })
      .mockReturnValueOnce({
        requestedAtEpochMs: 2,
        purgeAfterEpochMs: 60_002,
      });
    let forcedConflict = false;
    runtimeRepository.beforeConditionalWrite = async (operation, namespace, key) => {
      if (
        !forcedConflict &&
        operation === 'insertIfAbsent' &&
        namespace === RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE
      ) {
        forcedConflict = true;
        const endpointId = decodeURIComponent(key.slice('endpoint='.length));
        const peerSessionId = endpointId === 'session-a' ? 'session-b' : 'session-a';
        await runtimeRepository.upsert(
          namespace,
          key,
          JSON.stringify({
            endpointId,
            peers: [{ peerSessionId, expiresAtEpochMs: 60_001 }],
            version: 1,
            updatedAtEpochMs: 1,
          }),
          60_001,
        );
      }
    };

    await expect(
      executeRtcRttMutation({
        repository,
        runtime: runtimeRepository,
        command,
        readCommand,
        readFacts,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({
      updated: false,
      computed: {
        outcome: 'rejected',
        reason: 'no-shared-active-group',
      },
    });
    expect(readCommand).toHaveBeenCalledTimes(2);
    expect(readFacts).toHaveBeenCalledTimes(2);
    await expect(runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE)).resolves.toEqual([]);
  });

  it.each(
    (['duplicate', 'out-of-order'] as const).flatMap((defect) =>
      (['direct', 'list', 'page'] as const).map((surface) => ({
        defect,
        surface,
      })),
    ),
  )(
    'rejects $defect affected group refs on receipt $surface reads',
    async ({ defect, surface }) => {
      const runtimeRepository = new FakeRuntimeStateRepository();
      const repository = new RtcRttRepository(runtimeRepository, {
        now: () => 1,
      });
      const rtt = {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 1,
        createdAtEpochMs: 1,
        version: 1,
      };
      const receiptId = toRtcRttMutationReceiptId(rtt);
      const refA = { applicationId: 'app-1', groupId: 'room-a' };
      const refB = { applicationId: 'app-1', groupId: 'room-b' };
      await runtimeRepository.upsert(
        RTC_RTT_RECEIPTS_NAMESPACE,
        receiptId,
        JSON.stringify({
          receiptId,
          sessionIdFrom: rtt.sessionIdFrom,
          sessionIdTo: rtt.sessionIdTo,
          measurementVersion: rtt.version,
          affectedGroupRefs: defect === 'duplicate' ? [refA, refA] : [refB, refA],
          acceptedAtEpochMs: 1,
          outcome: 'accepted',
          commandHash: `sha256:${'a'.repeat(64)}`,
        }),
        86_400_001,
      );

      const read =
        surface === 'direct'
          ? repository.findMutationReceiptEntry(receiptId)
          : surface === 'list'
            ? repository.listMutationReceiptEntries()
            : repository.listMutationReceiptEntriesPage({
                limit: 10,
              });
      await expect(read).rejects.toMatchObject({
        code: 'rtc-topology-repository-invariant-corruption',
      });
    },
  );

  it.each([
    { name: 'exact replay', divergent: false },
    { name: 'divergent reuse', divergent: true },
  ])(
    'resolves $name from retained raw receipt authority without clocks or effects',
    async ({ divergent }) => {
      const runtimeRepository = new FakeRuntimeStateRepository();
      const baseRtt = {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 1,
        createdAtEpochMs: 1,
        version: 1,
      };
      const receiptId = toRtcRttMutationReceiptId(baseRtt);
      const commandHash = await hashMutationCommand({
        rtt: baseRtt,
        alSenderId: 'session-a',
      } as JsonWireValue);
      const affectedGroupRef = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-retained-replay',
      };
      await runtimeRepository.insertIfAbsent(
        RTC_RTT_RECEIPTS_NAMESPACE,
        receiptId,
        JSON.stringify({
          receiptId,
          commandId: receiptId,
          requestId: receiptId,
          sessionIdFrom: baseRtt.sessionIdFrom,
          sessionIdTo: baseRtt.sessionIdTo,
          aggregateRef: {
            sessionIdFrom: baseRtt.sessionIdFrom,
            sessionIdTo: baseRtt.sessionIdTo,
          },
          measurementVersion: baseRtt.version,
          affectedGroupRefs: [affectedGroupRef],
          acceptedAtEpochMs: 1,
          outcome: 'accepted',
          attemptCount: 1,
          acceptedStorageRevision: 0,
          eventId: null,
          outboxIds: [toRtcRttTopologyOutboxId(receiptId, affectedGroupRef, commandHash)],
          commandHash,
        }),
        1 + DEFAULT_RTC_RTT_MUTATION_RETENTION_MS,
      );
      const now = vi.fn(() => {
        throw new Error('RTT receipt replay clock');
      });
      const repository = new RtcRttRepository(runtimeRepository, { now });
      const policy = vi.fn(() => {
        throw new Error('RTT receipt replay policy');
      });
      const lifecycle = vi.fn(() => {
        throw new Error('RTT receipt replay lifecycle');
      });
      const measurement = vi
        .spyOn(repository, 'findMeasurementEntry')
        .mockRejectedValue(new Error('RTT receipt replay measurement'));
      const measurementList = vi
        .spyOn(repository, 'listMeasurementEntries')
        .mockRejectedValue(new Error('RTT receipt replay measurement list'));
      const admission = vi
        .spyOn(repository, 'findEndpointAdmissionEntry')
        .mockRejectedValue(new Error('RTT receipt replay admission'));
      const cleanup = vi
        .spyOn(runtimeRepository, 'deleteIfRevision')
        .mockRejectedValue(new Error('RTT receipt replay cleanup'));
      const transaction = vi
        .spyOn(runtimeRepository, 'begin')
        .mockRejectedValue(new Error('RTT receipt replay transaction'));
      const request = {
        rtt: divergent ? { ...baseRtt, rttMs: 2 } : baseRtt,
        alSenderId: 'session-a',
      };
      const executed = executeRtcRttMutation({
        repository,
        runtime: runtimeRepository,
        command: {
          ...request,
          candidateGroups: null,
          overlaySnapshotsByGroupKey: null,
          degreeLimit: null,
        },
        readCommand: policy,
        readFacts: lifecycle,
        sleep: async () => {},
      });

      if (divergent) {
        await expect(executed).rejects.toMatchObject({
          code: 'rtc-rtt-idempotency-conflict',
        });
      } else {
        await expect(executed).resolves.toMatchObject({
          updated: false,
          computed: { outcome: 'replay', reason: 'accepted' },
        });
      }
      expect(now).not.toHaveBeenCalled();
      expect(policy).not.toHaveBeenCalled();
      expect(lifecycle).not.toHaveBeenCalled();
      expect(measurement).not.toHaveBeenCalled();
      expect(measurementList).not.toHaveBeenCalled();
      expect(admission).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('replays an accepted RTT after measurement and admission expiry and rejects divergent reuse', async () => {
    let now = 1;
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new RtcRttRepository(runtimeRepository, {
      ttlMs: 10,
      now: () => now,
    });
    const group = createRttGroupSnapshot('room-replay', ['session-a', 'session-b']);
    const command = {
      rtt: {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 1,
        createdAtEpochMs: 1,
        version: 1,
      },
      alSenderId: 'session-a',
      candidateGroups: [group],
      overlaySnapshotsByGroupKey: new Map<string, RallarOverlayTopologySnapshot>(),
      degreeLimit: 1,
    };
    let readFacts: () => ReturnType<RtcRttRepository['readMutationFacts']> = () =>
      repository.readMutationFacts();
    const commandReader = {
      current: undefined as (() => typeof command) | undefined,
    };
    const execute = (nextCommand = command) =>
      executeRtcRttMutation({
        repository,
        runtime: runtimeRepository,
        command: nextCommand,
        ...(commandReader.current ? { readCommand: commandReader.current } : {}),
        readFacts,
        sleep: () => Promise.resolve(),
      });

    await expect(execute()).resolves.toMatchObject({
      updated: true,
      computed: { outcome: 'write' },
    });
    const receiptReads = vi.spyOn(repository, 'probeMutationReceiptEntry');
    const measurementReads = vi.spyOn(repository, 'findMeasurementEntry');
    const measurementLists = vi.spyOn(repository, 'listMeasurementEntries');
    const admissionReads = vi.spyOn(repository, 'findEndpointAdmissionEntry');
    const conditionalDeletes = vi.spyOn(runtimeRepository, 'deleteIfRevision');
    const conditionalUpdates = vi.spyOn(runtimeRepository, 'upsertIfRevision');
    const transactions = vi.spyOn(runtimeRepository, 'begin');
    const conditionalInserts = vi.spyOn(runtimeRepository, 'insertIfAbsent');
    const policyReads = vi.fn(() => {
      throw new Error('RTT replay read policy authority');
    });
    const lifecycleReads = vi.fn(() => {
      throw new Error('RTT replay read lifecycle clock');
    });
    commandReader.current = policyReads;
    readFacts = lifecycleReads;
    now = 12;
    await expect(execute()).resolves.toMatchObject({
      updated: false,
      computed: { outcome: 'replay', reason: 'accepted' },
    });
    expect(receiptReads).toHaveBeenCalledTimes(1);
    expect(measurementReads).not.toHaveBeenCalled();
    expect(measurementLists).not.toHaveBeenCalled();
    expect(admissionReads).not.toHaveBeenCalled();
    expect(conditionalDeletes).not.toHaveBeenCalled();
    expect(conditionalUpdates).not.toHaveBeenCalled();
    expect(transactions).not.toHaveBeenCalled();
    expect(conditionalInserts).not.toHaveBeenCalled();
    expect(policyReads).not.toHaveBeenCalled();
    expect(lifecycleReads).not.toHaveBeenCalled();
    await expect(
      execute({
        ...command,
        rtt: { ...command.rtt, rttMs: 2 },
      }),
    ).rejects.toMatchObject({ code: 'rtc-rtt-idempotency-conflict' });
    await expect(
      execute({
        ...command,
        alSenderId: 'session-b',
      }),
    ).rejects.toMatchObject({ code: 'rtc-rtt-idempotency-conflict' });
    expect(receiptReads).toHaveBeenCalledTimes(3);
    expect(measurementReads).not.toHaveBeenCalled();
    expect(measurementLists).not.toHaveBeenCalled();
    expect(admissionReads).not.toHaveBeenCalled();
    expect(conditionalDeletes).not.toHaveBeenCalled();
    expect(conditionalUpdates).not.toHaveBeenCalled();
    expect(transactions).not.toHaveBeenCalled();
    expect(conditionalInserts).not.toHaveBeenCalled();
    expect(policyReads).not.toHaveBeenCalled();
    expect(lifecycleReads).not.toHaveBeenCalled();
    expect(await runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE)).toHaveLength(1);
  });

  it('converges concurrent identical RTT writers through the immutable receipt winner', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    runtimeRepository.serializeTransactions = true;
    const repository = new RtcRttRepository(runtimeRepository, {
      now: () => 1,
    });
    const group = createRttGroupSnapshot('room-concurrent', ['session-a', 'session-b']);
    const command = {
      rtt: {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 1,
        createdAtEpochMs: 1,
        version: 1,
      },
      alSenderId: 'session-a',
      candidateGroups: [group],
      overlaySnapshotsByGroupKey: new Map<string, RallarOverlayTopologySnapshot>(),
      degreeLimit: 1,
    };
    let waiting = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => (release = resolve));
    const originalList = repository.listMeasurementEntries.bind(repository);
    vi.spyOn(repository, 'listMeasurementEntries').mockImplementation(async () => {
      const values = await originalList();
      waiting += 1;
      if (waiting === 2) release();
      if (waiting <= 2) await together;
      return values;
    });
    const execute = () =>
      executeRtcRttMutation({
        repository,
        runtime: runtimeRepository,
        command,
        readFacts: () => ({
          requestedAtEpochMs: 1,
          purgeAfterEpochMs: 60_001,
        }),
        sleep: async () => {},
      });

    const results = await Promise.all([execute(), execute()]);

    expect(results.filter(({ updated }) => updated)).toHaveLength(1);
    expect(results.filter(({ computed }) => computed.outcome === 'replay')).toHaveLength(1);
    expect(await runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE)).toHaveLength(1);
  });

  it('validates receipt identity before expiry cleanup on direct, list, and page reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const surfaces = ['direct', 'list', 'page'] as const;
      for (const surface of surfaces) {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
          now: () => 10_000,
        }) as RtcRttRepository & {
          listMutationReceiptEntries(): Promise<readonly unknown[]>;
          listMutationReceiptEntriesPage(input: { limit: number }): Promise<readonly unknown[]>;
        };
        const rtt = {
          sessionIdFrom: 'session-a',
          sessionIdTo: 'session-b',
          rttMs: 1,
          createdAtEpochMs: 1,
          version: 1,
        };
        const receiptId = toRtcRttMutationReceiptId(rtt);
        await runtimeRepository.upsert(
          RTC_RTT_RECEIPTS_NAMESPACE,
          receiptId,
          JSON.stringify({
            receiptId,
            sessionIdFrom: rtt.sessionIdFrom,
            sessionIdTo: rtt.sessionIdTo,
            measurementVersion: rtt.version,
            affectedGroupRefs: [],
            acceptedAtEpochMs: 1,
            outcome: 'accepted',
            commandHash: `sha256:${'A'.repeat(64)}`,
          }),
          9_000,
        );

        const read =
          surface === 'direct'
            ? repository.findMutationReceipt(receiptId)
            : surface === 'list'
              ? repository.listMutationReceiptEntries()
              : repository.listMutationReceiptEntriesPage({
                  limit: 10,
                });
        await expect(read).rejects.toMatchObject({
          code: 'rtc-topology-repository-invariant-corruption',
        });
        expect(
          await runtimeRepository.findEntry(RTC_RTT_RECEIPTS_NAMESPACE, receiptId),
        ).toBeDefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes lifecycle facts after an RTT conflict crosses peer expiry', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new RtcRttRepository(runtimeRepository, {
      now: () => 0,
    });
    const originalBegin = runtimeRepository.begin.bind(runtimeRepository);
    vi.spyOn(runtimeRepository, 'begin')
      .mockImplementationOnce(async () => {
        await repository.commitEndpointAdmission(
          {
            endpointId: 'session-a',
            peers: [
              {
                peerSessionId: 'session-c',
                expiresAtEpochMs: 5,
              },
            ],
            version: 1,
            updatedAtEpochMs: 0,
          },
          null,
          5,
        );
        throw new RuntimeStateWriteConflictError();
      })
      .mockImplementation(originalBegin);
    const requestedAtEpochMs = [1, 6];
    const readFacts = vi.fn(() => {
      const requestedAt = requestedAtEpochMs.shift();
      if (requestedAt === undefined) throw new Error('facts exhausted');
      return {
        requestedAtEpochMs: requestedAt,
        purgeAfterEpochMs: requestedAt + 100,
      };
    });
    const group = createRttGroupSnapshot('room-ab', ['session-a', 'session-b']);

    const result = await executeRtcRttMutation({
      repository,
      runtime: runtimeRepository,
      command: {
        rtt: {
          sessionIdFrom: 'session-a',
          sessionIdTo: 'session-b',
          rttMs: 1,
          createdAtEpochMs: 1,
          version: 1,
        },
        alSenderId: 'session-a',
        candidateGroups: [group],
        overlaySnapshotsByGroupKey: new Map(),
        degreeLimit: 1,
      },
      readFacts,
      sleep: async () => {},
    });

    expect(result).toMatchObject({
      updated: true,
      computed: {
        outcome: 'write',
        measurementGuard: { purgeAfterEpochMs: 106 },
        receipt: { acceptedAtEpochMs: 6 },
      },
    });
    if (result.computed.outcome !== 'write') throw new Error('Expected write');
    expect(result.computed.endpointGuards[0]).toMatchObject({
      endpointId: 'session-a',
      value: {
        peers: [
          {
            peerSessionId: 'session-b',
            expiresAtEpochMs: 106,
          },
        ],
        updatedAtEpochMs: 6,
      },
    });
    expect(readFacts).toHaveBeenCalledTimes(2);
    expect(requestedAtEpochMs).toEqual([]);
    await expect(repository.findMeasurementEntry('session-a', 'session-b')).resolves.toMatchObject({
      entry: { expireAtTimestamp: 106 },
    });
  });

  it('fully rereads RTT authority after conflict when a session connection boundary moves past acceptance', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new RtcRttRepository(runtimeRepository, {
      now: () => 0,
    });
    const originalBegin = runtimeRepository.begin.bind(runtimeRepository);
    const begin = vi
      .spyOn(runtimeRepository, 'begin')
      .mockImplementationOnce(() => {
        throw new RuntimeStateWriteConflictError();
      })
      .mockImplementation(originalBegin);
    const initial = createRttGroupSnapshot('room-session-boundary', ['session-a', 'session-b']);
    const futureConnection: GroupSnapshot = {
      ...initial,
      activeSessions: initial.activeSessions.map((session) => ({
        ...session,
        generationVersion: 3,
        connectedAtEpochMs: 3,
        lastHeartbeatAtEpochMs: 3,
      })),
    };
    const commands = [initial, futureConnection];
    const readCommand = vi.fn(() => {
      const group = commands.shift();
      if (!group) throw new Error('commands exhausted');
      return {
        rtt: {
          sessionIdFrom: 'session-a',
          sessionIdTo: 'session-b',
          rttMs: 1,
          createdAtEpochMs: 1,
          version: 1,
        },
        alSenderId: 'session-a',
        candidateGroups: [group],
        overlaySnapshotsByGroupKey: new Map(),
        degreeLimit: 1,
      };
    });
    const stableCommand = readCommand();
    commands.unshift(initial);

    const result = await executeRtcRttMutation({
      repository,
      runtime: runtimeRepository,
      command: stableCommand,
      readCommand,
      readFacts: () => ({
        requestedAtEpochMs: 2,
        purgeAfterEpochMs: 60_002,
      }),
      sleep: async () => {},
    });

    expect(result).toMatchObject({
      updated: false,
      computed: {
        outcome: 'rejected',
        reason: 'no-shared-active-group',
      },
    });
    expect(readCommand).toHaveBeenCalledTimes(3);
    expect(begin).toHaveBeenCalledTimes(1);
    await expect(repository.findMeasurement('session-a', 'session-b')).resolves.toBeUndefined();
  });
});

function createUnopenedTransactionSql(): PSqlTransactionSql {
  return Object.assign(
    () => {
      throw new Error('RTT write must not query the transaction');
    },
    {
      begin: () => {
        throw new Error('RTT write must not open a transaction');
      },
    },
  );
}
