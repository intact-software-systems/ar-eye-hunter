import { vi } from 'vitest';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import {
  createTestGroupStateRuntime,
  createTestGroupStateService,
  type TestAuthenticatedGroupStateService,
} from '../group-state-test-runtime.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { SCOPE, groupRef } from '../mutation/group-mutation-test-runtime.ts';

export function createService(
  runtimeRepository: GroupBarrierRepository,
  nowEpochMs: number | (() => number),
  sleep: (delayMs: number) => Promise<void> = () => Promise.resolve(),
  injectedRandomId?: () => string,
  timing?: (event: RallarTimingEvent) => void,
) {
  let id = 0;
  const currentNow = () => (typeof nowEpochMs === 'function' ? nowEpochMs() : nowEpochMs);
  return createTestGroupStateService({
    runtimeRepository,
    syncPublisher: createPublisher(),
    formationDamping: 'damped',
    now: currentNow,
    randomId: injectedRandomId ?? (() => `id-${currentNow()}-${++id}`),
    sleep,
    serviceId: 'group-service',
    timing,
  });
}

export function createMaintenance(
  runtimeRepository: GroupBarrierRepository,
  nowEpochMs: number,
  sleep: (delayMs: number) => Promise<void> = () => Promise.resolve(),
) {
  return createTestGroupStateRuntime({
    runtimeRepository,
    formationDamping: 'damped',
    now: () => nowEpochMs,
    randomId: () => `maintenance-${nowEpochMs}`,
    sleep,
    serviceId: 'group-maintenance',
  }).maintenance;
}

interface ConvergeSummaryForTestInput {
  readonly work: GroupPresenceSummaryWork;
  readonly runtime: GroupBarrierRepository;
  readonly ref: GroupRef;
  readonly commandId: string;
}

export async function convergeSummaryForTest({
  work,
  runtime,
  ref,
  commandId,
}: ConvergeSummaryForTestInput): Promise<void> {
  const repository = new GroupStateRepository(runtime);
  const event = (await repository.listEvents(ref)).at(-1);
  if (!event) throw new Error(`Missing group event for summary: ${ref.groupId}`);
  const command: GroupPresenceSummaryWorkData = {
    effectKind: 'group-presence-summary',
    aggregateRef: ref,
    commandId,
    createdAtEpochMs: event.occurredAtEpochMs,
    expireAtEpochMs: 253_402_300_799_999,
    acceptedCausalRevision: event.causalRevision,
    event,
  };
  const read = await work.read(command);
  const computed = work.compute(command, read);
  work.validate(command, read, computed);
  await runtime.begin(async (transaction) => {
    if (computed.summary.outcome === 'no-op') return;
    const transactionRepository = new GroupStateRepository(transaction);
    requireConditionalWrite(
      computed.summary.operation === 'insert'
        ? await transactionRepository.insertPresenceSummary(computed.summary.summary)
        : await transactionRepository.updatePresenceSummary(
            computed.summary.summary,
            computed.summary.expectedRevision!,
          ),
    );
  });
}

export async function seedOpenGroup(
  runtime: GroupBarrierRepository,
  groupId: string,
  maxMembers = 10,
): Promise<void> {
  await createService(runtime, 1_000).createGroup(SCOPE, {
    groupId,
    displayName: groupId,
    kind: 'room',
    joinMode: 'open',
    maxMembers,
    createdByPrincipalId: 'alice',
    requestId: `seed-${groupId}`,
  });
}

export async function requireSnapshot(runtime: GroupBarrierRepository, groupId: string) {
  const snapshot = await new GroupStateRepository(runtime).readSnapshot(groupRef(groupId));
  if (!snapshot) throw new Error(`Missing group snapshot: ${groupId}`);
  return snapshot;
}

export function createPublisher(): StateSyncPublisher {
  return {
    publishClientSnapshot: vi.fn(() => Promise.resolve()),
    publishClientEvent: vi.fn(() => Promise.resolve()),
    publishGroupSnapshot: vi.fn(() => Promise.resolve()),
    publishGroupEvent: vi.fn(() => Promise.resolve()),
  };
}

interface CorruptFirstEntryInput {
  readonly runtime: GroupBarrierRepository;
  readonly namespace: string;
  readonly corrupt: (value: Record<string, unknown>) => Record<string, unknown>;
}

export async function corruptFirstEntry({
  runtime,
  namespace,
  corrupt,
}: CorruptFirstEntryInput): Promise<void> {
  const entry = (await runtime.findAllEntries(namespace))[0];
  if (!entry) throw new Error(`Missing ${namespace} entry to corrupt`);
  await runtime.upsert(
    namespace,
    entry.key,
    JSON.stringify(corrupt(JSON.parse(entry.value) as Record<string, unknown>)),
    entry.expireAtTimestamp,
  );
}
