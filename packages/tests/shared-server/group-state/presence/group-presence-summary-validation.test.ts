import { describe, expect, it } from 'vitest';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import {
  corruptFirstEntry,
  convergeSummaryForTest,
  createService,
} from './group-presence-test-runtime.ts';
import { SCOPE, groupRef } from '../mutation/group-mutation-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

describe('group presence summary validation', () => {
  it('filters a stale admitted generation through the latest inactive membership', async () => {
    const runtime = new GroupBarrierRepository();
    const service = createService(runtime, BASE_EPOCH_MS);
    await service.createGroup(SCOPE, {
      groupId: 'inactive-summary-filter',
      displayName: 'Inactive summary filter',
      kind: 'room',
      joinMode: 'open',
      createdByPrincipalId: 'alice',
      requestId: 'seed-inactive-summary-filter',
    });
    await service.upsertMember(SCOPE, 'inactive-summary-filter', 'bob', {
      status: 'active',
      actorPrincipalId: 'alice',
      requestId: 'activate-filter-bob',
    });
    await service.connectPresenceSession(SCOPE, 'inactive-summary-filter', 'filter-bob-session', {
      principalId: 'bob',
      generationId: 'filter-bob-generation',
      actorPrincipalId: 'bob',
      expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
      requestId: 'connect-filter-bob',
    });
    const repository = new GroupStateRepository(runtime);
    const ref = groupRef('inactive-summary-filter');
    const admitted = await repository.findPresenceAdmissionEntry({
      ...ref,
      principalId: 'bob',
    });
    if (!admitted) throw new Error('Expected admitted bob generation');

    await service.banGroupMember(SCOPE, 'inactive-summary-filter', 'bob', {
      actorPrincipalId: 'alice',
      requestId: 'ban-filter-bob',
    });
    await corruptFirstEntry({
      runtime,
      namespace: 'group-state:presence-admissions',
      corrupt: (value) => ({
        ...value,
        admittedSessions: admitted.value.admittedSessions,
      }),
    });

    const summaryWork = new GroupPresenceSummaryWork({
      topologyIntent: { damping: 'legacy' },
      disseminationMode: 'dual-emit',
      runtimeRepository: runtime,
      now: () => BASE_EPOCH_MS + 3_000,
      serviceId: 'summary-worker',
    });
    await convergeSummaryForTest({
      work: summaryWork,
      runtime,
      ref,
      commandId: 'inactive-summary-filter',
    });

    expect((await repository.findPresenceSummaryEntry(ref))?.value).toMatchObject({
      activePrincipalIds: [],
      activeSessionIds: [],
    });
  });

  it.each([
    [
      'wrong-scope member',
      'group-state:members',
      (value: Record<string, unknown>) => ({
        ...value,
        groupId: 'wrong-group',
      }),
    ],
    [
      'wrong-scope admission',
      'group-state:presence-admissions',
      (value: Record<string, unknown>) => ({ ...value, groupId: 'wrong-group' }),
    ],
    [
      'impossible session lifecycle',
      'group-state:sessions',
      (value: Record<string, unknown>) => ({
        ...value,
        lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 50_000,
        expiresAtEpochMs: BASE_EPOCH_MS + 40_000,
      }),
    ],
    [
      'malformed current summary',
      'group-state:presence-summaries',
      (value: Record<string, unknown>) => ({ ...value, unexpected: true }),
    ],
  ] as const)('rejects %s before the summary CAS', async (_label, namespace, corrupt) => {
    const runtime = new GroupBarrierRepository();
    const service = createService(runtime, BASE_EPOCH_MS);
    await service.createGroup(SCOPE, {
      groupId: `corrupt-summary-${namespace}`,
      displayName: 'Corrupt summary',
      kind: 'room',
      joinMode: 'open',
      createdByPrincipalId: 'alice',
      requestId: `seed-corrupt-summary-${namespace}`,
    });
    await service.connectPresenceSession(
      SCOPE,
      `corrupt-summary-${namespace}`,
      'alice-corrupt-session',
      {
        principalId: 'alice',
        generationId: 'alice-corrupt-generation',
        actorPrincipalId: 'alice',
        expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
        requestId: `connect-corrupt-summary-${namespace}`,
      },
    );
    await corruptFirstEntry({ runtime, namespace, corrupt });
    runtime.resetGuards();

    const summaryWork = new GroupPresenceSummaryWork({
      topologyIntent: { damping: 'legacy' },
      disseminationMode: 'dual-emit',
      runtimeRepository: runtime,
      now: () => BASE_EPOCH_MS + 3_000,
      serviceId: 'summary-worker',
    });
    await expect(
      convergeSummaryForTest({
        work: summaryWork,
        runtime,
        ref: groupRef(`corrupt-summary-${namespace}`),
        commandId: `corrupt-${namespace}`,
      }),
    ).rejects.toThrow(/scope|lifecycle|timestamp|unexpected|serialized|summary/i);
    expect(runtime.presenceSummaryGuards).toBe(0);
  });
});
