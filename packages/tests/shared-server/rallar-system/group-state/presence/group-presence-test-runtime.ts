import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { GroupPresenceSummaryReservationRead } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { createTestGroupStateRuntime, createTestGroupStateService, type GroupStateTestService } from '../group-state-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';

export function createService(
    runtimeRepository: GroupBarrierRepository,
    nowEpochMs: number | (() => number),
    attemptCount = 1,
    injectedRandomId?: () => string,
    timing?: (event: RallarTimingEvent) => void
): GroupStateTestService {
    let id = 0;
    const currentNow = () => (typeof nowEpochMs === 'function' ? nowEpochMs() : nowEpochMs);
    return createTestGroupStateService({
        runtimeRepository,
        now: currentNow,
        randomId: injectedRandomId ?? (() => `id-${currentNow()}-${++id}`),
        attemptCount,
        serviceId: 'group-service',
        timing
    });
}

export function createMaintenance(
    runtimeRepository: GroupBarrierRepository,
    nowEpochMs: number,
    attemptCount = 1
) {
    return createTestGroupStateRuntime({
        runtimeRepository,
        now: () => nowEpochMs,
        randomId: () => `maintenance-${nowEpochMs}`,
        attemptCount,
        serviceId: 'group-maintenance'
    }).maintenance;
}

interface ConvergeSummaryForTestInput {
    readonly work: GroupPresenceSummaryWork;
    readonly runtime: GroupBarrierRepository;
    readonly ref: GroupRef;
    readonly commandId: string;
    readonly nowEpochMs: number;
}

export async function convergeSummaryForTest({
    work,
    runtime,
    ref,
    commandId,
    nowEpochMs
}: ConvergeSummaryForTestInput): Promise<void> {
    const repository = createTestGroupStateRepository(runtime);
    const event = (await repository.listEvents(ref)).at(-1);
    if (!event) {
        throw new Error(`Missing group event for summary: ${ref.groupId}`);
    }
    const command: GroupPresenceSummaryWorkData = {
        effectKind: 'group-presence-summary',
        aggregateRef: ref,
        commandId,
        createdAtEpochMs: event.occurredAtEpochMs,
        expireAtEpochMs: 253_402_300_799_999,
        acceptedCausalRevision: event.causalRevision,
        event
    };
    const read = await work.read(command, summaryReservationRead(command.commandId), nowEpochMs);
    const computed = work.compute(command, read);
    work.validate(command, read, computed);
    await runtime.begin(async (transaction) => {
        if (computed.summary.outcome === 'no-op') {
            return;
        }
        const transactionRepository = createTestGroupStateRepository(
            transaction,
            runtime.groupStateEventStore
        );
        requireConditionalWrite(
            computed.summary.operation === 'insert'
                ? await transactionRepository.insertPresenceSummary(computed.summary.summary)
                : await transactionRepository.updatePresenceSummary(
                    computed.summary.summary,
                    computed.summary.expectedRevision!
                )
        );
    });
}

export function summaryReservationRead(commandId: string): GroupPresenceSummaryReservationRead {
    return {
        key: {
            topicId: 'test.group-presence-summary',
            resourceId: commandId,
            contextId: 'test.group-presence-summary'
        },
        expectedAttempts: 1
    };
}

export async function seedOpenGroup(
    runtime: GroupBarrierRepository,
    groupId: string,
    maxMembers = 10
): Promise<void> {
    await createService(runtime, 1_000).createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        maxMembers,
        createdByPrincipalId: 'alice',
        requestId: `seed-${groupId}`
    });
}

export async function requireSnapshot(runtime: GroupBarrierRepository, groupId: string) {
    const snapshot = await createTestGroupStateRepository(runtime).readSnapshot(groupRef(groupId));
    if (!snapshot) {
        throw new Error(`Missing group snapshot: ${groupId}`);
    }
    return snapshot;
}

interface CorruptFirstEntryInput {
    readonly runtime: GroupBarrierRepository;
    readonly namespace: string;
    readonly corrupt: (value: JsonWireObject) => JsonWireObject;
}

export async function corruptFirstEntry({
    runtime,
    namespace,
    corrupt
}: CorruptFirstEntryInput): Promise<void> {
    const entry = (await runtime.findAllEntries(namespace))[0];
    if (!entry) {
        throw new Error(`Missing ${namespace} entry to corrupt`);
    }
    const persisted = decodeJsonWireValue(JSON.parse(entry.value), `${namespace} entry`);
    if (!isJsonWireObject(persisted)) {
        throw new TypeError(`Expected ${namespace} entry to be a JSON object`);
    }
    await runtime.upsert(
        namespace,
        entry.key,
        JSON.stringify(corrupt(persisted)),
        entry.expireAtTimestamp
    );
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
