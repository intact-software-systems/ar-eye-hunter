import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { encodeJsonWireValue, hashMutationCommand } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { computeRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/compute-rtc-rtt-mutation.ts';
import { readRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/read-rtc-rtt-mutation.ts';
import type {
    RtcRttMutationCommand,
    RtcRttMutationComputed,
    RtcRttMutationFacts,
    RtcRttMutationLifecycleFacts,
    RtcRttStableRequest
} from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-contracts.ts';
import { validateRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/validate-rtc-rtt-mutation.ts';
import { writeRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/write-rtc-rtt-mutation.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import type { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';

interface ExecuteRtcRttMutationResult {
    readonly computed: RtcRttMutationComputed;
    readonly updated: boolean;
}

interface ExecuteRtcRttMutationInput {
    readonly repository: RtcRttRepository;
    readonly transaction: PSqlSql;
    readonly outboxWriter: RtcTopologyOutboxWriter;
    readonly readFacts: () => RtcRttMutationLifecycleFacts | Promise<RtcRttMutationLifecycleFacts>;
    readonly request: RtcRttStableRequest;
    readonly readCommand: () => RtcRttMutationCommand | Promise<RtcRttMutationCommand>;
    readonly attemptCount: number;
}

/** Executes one deliberately transaction-controlled RTT mutation for concurrency tests. */
export async function executeRtcRttMutation(
    input: ExecuteRtcRttMutationInput
): Promise<ExecuteRtcRttMutationResult> {
    const stableRequest = input.request;
    const commandHash = await hashMutationCommand(
        encodeJsonWireValue(stableRequest, 'RTC RTT stable request')
    );
    const read = await readRtcRttMutation(input.repository, stableRequest);
    let command: RtcRttMutationCommand;
    let facts: RtcRttMutationFacts;
    if (read.receipt) {
        command = {
            ...stableRequest,
            candidateGroups: null,
            overlaySnapshotsByGroupKey: null,
            degreeLimit: null
        };
        facts = {
            commandHash,
            attemptCount: input.attemptCount,
            requestedAtEpochMs: null,
            purgeAfterEpochMs: null
        };
    }
    else {
        command = await input.readCommand();
        facts = {
            ...(await input.readFacts()),
            commandHash,
            attemptCount: input.attemptCount
        };
    }
    const computed = computeRtcRttMutation({ command, read, facts });
    validateRtcRttMutation({ command, read, facts, computed });
    if (computed.outcome !== 'write') {
        return { computed, updated: false };
    }
    await writeRtcRttMutation({
        transaction: input.transaction,
        computed,
        outboxWriter: input.outboxWriter
    });
    return { computed, updated: true };
}
