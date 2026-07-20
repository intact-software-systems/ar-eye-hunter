import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    RtcRttRepository,
} from '../repositories/RtcRttRepository.ts';
import {
    RTC_RTT_MUTATION_RETENTION_MS,
    validateRtcRttWriteCandidate,
} from '../rtc-rtt-persistence-validation.ts';
import { hashStateMutationCommand } from '../repositories/StateMutationOutboxRepository.ts';
import {
    compareRtcTopologyIdentifiers,
    toRtcRttMutationReceiptId,
} from '../rtc-topology-identifiers.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';
import {
    computeRttMutation,
    type RtcRttMutationCommand,
    type RtcRttMutationComputed,
    type RtcRttMutationFacts,
    type RtcRttMutationLifecycleFacts,
    type RtcRttMutationRead,
    type RtcRttStableRequest,
    validateRttMutation,
} from './rtc-topology-mutations.ts';
import { recordRallarTiming, type RallarTimingSink } from './timing.ts';

export async function readRttMutation(
    repository: RtcRttRepository,
    request: RtcRttStableRequest,
): Promise<RtcRttMutationRead> {
    const receipt = await repository.probeMutationReceiptEntry(
        toRtcRttMutationReceiptId(request.rtt),
    );
    if (receipt) return { receipt };

    const [measurement, measurements, ...endpointAdmissions] = await Promise.all([
        repository.findMeasurementEntry(
            request.rtt.sessionIdFrom,
            request.rtt.sessionIdTo,
        ),
        repository.listMeasurementEntries(),
        ...[...new Set([
            request.rtt.sessionIdFrom,
            request.rtt.sessionIdTo,
        ])].sort(compareRtcTopologyIdentifiers).map((endpointId) =>
            repository.findEndpointAdmissionEntry(endpointId)
        ),
    ]);
    return {
        receipt: null,
        measurement: measurement ?? null,
        endpointAdmissions: endpointAdmissions.filter((entry): entry is
            NonNullable<typeof entry> => entry !== undefined),
        measurements,
    };
}

export async function writeRttMutation(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    options: ConstructorParameters<typeof RtcRttRepository>[1],
    computed: Extract<RtcRttMutationComputed, { outcome: 'write' }>,
): Promise<'accepted' | 'conflict'> {
    const mutationExpireAtTimestamp = computed.receipt.acceptedAtEpochMs +
        RTC_RTT_MUTATION_RETENTION_MS;
    validateRtcRttWriteCandidate(computed, mutationExpireAtTimestamp);
    try {
        const accepted = await runtime.begin(async (transaction) => {
            const repository = new RtcRttRepository(transaction, options);
            for (let index = 0; index < computed.endpointGuards.length; index += 1) {
                const guard = computed.endpointGuards[index]!;
                const written = await repository.commitEndpointAdmission(
                    guard.value,
                    guard.expectedRevision,
                    guard.expireAtTimestamp,
                );
                if (written.status === 'conflict') {
                    if (index === 0) return false;
                    throw new RuntimeStateWriteConflictError();
                }
            }
            const measurement = await repository.commitMeasurement(
                computed.measurementGuard.value,
                computed.measurementGuard.expectedRevision,
                computed.measurementGuard.purgeAfterEpochMs,
            );
            if (measurement.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
            const receipt = await repository.insertMutationReceipt(
                computed.receipt,
                mutationExpireAtTimestamp,
            );
            if (receipt.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
            for (const intent of computed.recomputeIntents) {
                const inserted = await repository.insertRecomputeIntent(
                    intent,
                    mutationExpireAtTimestamp,
                );
                if (inserted.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
            }
            return true;
        });
        return accepted ? 'accepted' : 'conflict';
    } catch (error) {
        if (error instanceof RuntimeStateWriteConflictError) return 'conflict';
        throw error;
    }
}

export type ExecuteRttMutationResult = Readonly<{
    computed: RtcRttMutationComputed;
    updated: boolean;
}>;

type ExecuteRttMutationBase = Readonly<{
    repository: RtcRttRepository;
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike;
    readFacts: () =>
        | RtcRttMutationLifecycleFacts
        | Promise<RtcRttMutationLifecycleFacts>;
    sleep?: (delayMs: number) => Promise<void>;
    timing?: RallarTimingSink;
    serviceId?: string;
}>;

type ExecuteRttMutationInput = ExecuteRttMutationBase & Readonly<{
    request: RtcRttStableRequest;
    readCommand: () => RtcRttMutationCommand | Promise<RtcRttMutationCommand>;
}>;

export async function executeRttMutation(
    input: ExecuteRttMutationInput,
): Promise<ExecuteRttMutationResult> {
    const stableRequest = input.request;
    const commandHash = await hashStateMutationCommand(stableRequest);
    let lastConflict: RuntimeStateWriteConflictError | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const backoffMs = await waitForRuntimeStateWriteRetry(attempt as 0 | 1 | 2, {
            sleep: input.sleep,
        });
        const readStarted = performance.now();
        const read = await readRttMutation(input.repository, stableRequest);
        recordRttPhase(
            input,
            stableRequest,
            'read',
            readStarted,
            attempt,
            backoffMs,
        );

        let command: RtcRttMutationCommand;
        let facts: RtcRttMutationFacts;
        if (read.receipt) {
            command = {
                ...stableRequest,
                candidateGroups: null,
                overlaySnapshotsByGroupKey: null,
                degreeLimit: null,
            };
            facts = {
                commandHash,
                requestedAtEpochMs: null,
                purgeAfterEpochMs: null,
            };
        } else {
            command = await input.readCommand();
            if (!sameRttRequest(command, stableRequest)) {
                throw new TypeError('RTC RTT retry changed the stable request payload');
            }
            facts = { ...await input.readFacts(), commandHash };
        }

        const computeStarted = performance.now();
        const computed = computeRttMutation({ command, read, facts });
        recordRttPhase(
            input,
            stableRequest,
            'compute',
            computeStarted,
            attempt,
            backoffMs,
        );

        const validateStarted = performance.now();
        validateRttMutation({ command, read, facts, computed });
        recordRttPhase(
            input,
            stableRequest,
            'validate',
            validateStarted,
            attempt,
            backoffMs,
        );
        if (computed.outcome === 'rejected' || computed.outcome === 'replay') {
            return { computed, updated: false };
        }
        if (
            facts.requestedAtEpochMs === null ||
            facts.purgeAfterEpochMs === null
        ) {
            throw new TypeError('RTC RTT write is missing lifecycle facts');
        }

        const writeStarted = performance.now();
        const transactionStarted = performance.now();
        const written = await writeRttMutation(
            input.runtime,
            {
                ttlMs: facts.purgeAfterEpochMs - facts.requestedAtEpochMs,
                now: () => facts.requestedAtEpochMs,
            },
            computed,
        );
        recordRttPhase(
            input,
            stableRequest,
            'transaction',
            transactionStarted,
            attempt,
            backoffMs,
        );
        recordRttPhase(
            input,
            stableRequest,
            'write',
            writeStarted,
            attempt,
            backoffMs,
        );
        if (written === 'accepted') return { computed, updated: true };

        lastConflict = new RuntimeStateWriteConflictError();
        recordRallarTiming(input.timing, {
            component: 'rtc-rtt-service',
            operation: 'mutation.conflict',
            serviceId: input.serviceId,
            requestId: requestId(stableRequest),
            details: { attempt, backoffMs, conflict: true },
        }, 'error', 0, lastConflict);
    }
    throw new RuntimeStateRetryExhaustedError(
        lastConflict ?? new RuntimeStateWriteConflictError(),
    );
}

function sameRttRequest(
    command: RtcRttMutationCommand,
    request: RtcRttStableRequest,
): boolean {
    return rtcTopologySemanticEqual(command.rtt, request.rtt) &&
        command.alSenderId === request.alSenderId;
}

function recordRttPhase(
    input: Pick<ExecuteRttMutationBase, 'timing' | 'serviceId'>,
    request: RtcRttStableRequest,
    phase: 'read' | 'compute' | 'validate' | 'transaction' | 'write',
    started: number,
    attempt: number,
    backoffMs: number,
): void {
    recordRallarTiming(input.timing, {
        component: 'rtc-rtt-service',
        operation: `mutation.${phase}`,
        serviceId: input.serviceId,
        requestId: requestId(request),
        details: { attempt, backoffMs },
    }, 'ok', performance.now() - started);
}

function requestId(request: RtcRttStableRequest): string {
    return `${request.rtt.sessionIdFrom}:${request.rtt.sessionIdTo}:${request.rtt.version}`;
}
