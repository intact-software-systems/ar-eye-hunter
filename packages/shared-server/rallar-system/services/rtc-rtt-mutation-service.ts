import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '../../postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { RtcRttRepository } from '../repositories/RtcRttRepository.ts';
import {
    RTC_RTT_MUTATION_RETENTION_MS,
    validateRtcRttWriteCandidate,
} from '../rtc-rtt-persistence-validation.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { hashCanonicalCommand } from './canonical-command-hash.ts';
import {
    compareRtcTopologyIdentifiers,
    toRtcRttMutationReceiptId,
} from '../rtc-topology-identifiers.ts';
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
import { writeRtcTopologyOutbox } from './rtc-topology-outbox-entry.ts';

export async function readRttMutation(
    repository: RtcRttRepository,
    request: RtcRttStableRequest,
): Promise<RtcRttMutationRead> {
    const receipt = await repository.probeMutationReceiptEntry(
        toRtcRttMutationReceiptId(request.rtt),
    );
    if (receipt) return { receipt };

    const [measurement, measurements, ...endpointAdmissionReads] =
        await Promise.all([
            repository.readMeasurementEntry(
                request.rtt.sessionIdFrom,
                request.rtt.sessionIdTo,
            ),
            repository.listMeasurementEntries(),
            ...[
                ...new Set([
                    request.rtt.sessionIdFrom,
                    request.rtt.sessionIdTo,
                ]),
            ]
                .sort(compareRtcTopologyIdentifiers)
                .map((endpointId) =>
                    repository.readEndpointAdmissionEntry(endpointId),
                ),
        ]);
    return {
        receipt: null,
        measurement: measurement.value ?? null,
        expiredMeasurementEntry: measurement.expiredEntry ?? null,
        endpointAdmissions: endpointAdmissionReads.flatMap((read) =>
            read.value ? [read.value] : []
        ),
        expiredEndpointAdmissionEntries: endpointAdmissionReads.flatMap((read) =>
            read.expiredEntry ? [read.expiredEntry] : []
        ),
        measurements,
    };
}

export async function writeRttMutation(
    transaction: PSqlTransactionSql,
    options: ConstructorParameters<typeof RtcRttRepository>[1],
    computed: Extract<RtcRttMutationComputed, { outcome: 'write' }>,
): Promise<'accepted'> {
    const mutationExpireAtTimestamp =
        computed.receipt.acceptedAtEpochMs + RTC_RTT_MUTATION_RETENTION_MS;
    validateRtcRttWriteCandidate(computed, mutationExpireAtTimestamp);
    const runtime = new PSqlRuntimeStateRepository(transaction);
    const repository = new RtcRttRepository(runtime, options);
    for (const guard of computed.endpointGuards) {
        requireAcceptedRttWrite(
            await repository.commitEndpointAdmission(
                guard.value,
                guard.expectedRevision,
                guard.expireAtTimestamp,
            ),
        );
    }
    requireAcceptedRttWrite(
        await repository.commitMeasurement(
            computed.measurementGuard.value,
            computed.measurementGuard.expectedRevision,
            computed.measurementGuard.purgeAfterEpochMs,
        ),
    );
    requireAcceptedRttWrite(
        await repository.insertMutationReceipt(
            computed.receipt,
            mutationExpireAtTimestamp,
        ),
    );
    for (const intent of computed.recomputeIntents) {
        await writeRtcTopologyOutbox(transaction, {
            commandId: intent.receiptId,
            resourceId: intent.outboxId,
            aggregateRef: intent.groupSnapshot.group,
            acceptedCausalRevision: intent.groupSnapshot.causalRevision,
            groupSnapshot: intent.groupSnapshot,
            effectKind: 'rtc-topology-recompute',
            payloadKind: 'group-revision',
            createdAtEpochMs: intent.createdAtEpochMs,
            expireAtEpochMs: mutationExpireAtTimestamp,
            senderId: intent.senderId,
            requestOptions: toCanonicalGroupTopologyConfigPatch({}),
            publish: true,
        });
    }
    return 'accepted';
}

export type ExecuteRttMutationResult = Readonly<{
    computed: RtcRttMutationComputed;
    updated: boolean;
}>;

export type ExecuteRttMutationInput = Readonly<{
    repository: RtcRttRepository;
    transaction: PSqlTransactionSql;
    readFacts: () =>
        RtcRttMutationLifecycleFacts | Promise<RtcRttMutationLifecycleFacts>;
    request: RtcRttStableRequest;
    readCommand: () => RtcRttMutationCommand | Promise<RtcRttMutationCommand>;
    attemptCount: number;
}>;

export async function executeRttMutation(
    input: ExecuteRttMutationInput,
): Promise<ExecuteRttMutationResult> {
    const stableRequest = input.request;
    const commandHash = await hashCanonicalCommand(stableRequest);
    const read = await readRttMutation(input.repository, stableRequest);
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
            attemptCount: input.attemptCount,
            requestedAtEpochMs: null,
            purgeAfterEpochMs: null,
        };
    } else {
        command = await input.readCommand();
        facts = {
            ...(await input.readFacts()),
            commandHash,
            attemptCount: input.attemptCount,
        };
    }
    const computed = computeRttMutation({ command, read, facts });
    validateRttMutation({ command, read, facts, computed });
    if (computed.outcome !== 'write') return { computed, updated: false };
    if (facts.requestedAtEpochMs === null || facts.purgeAfterEpochMs === null) {
        throw new TypeError('RTC RTT write is missing lifecycle facts');
    }
    await writeRttMutation(
        input.transaction,
        {
            ttlMs: facts.purgeAfterEpochMs - facts.requestedAtEpochMs,
            now: () => facts.requestedAtEpochMs,
        },
        computed,
    );
    return { computed, updated: true };
}

function requireAcceptedRttWrite(
    result: Readonly<{ status: 'accepted' | 'conflict' }>,
): void {
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
}
