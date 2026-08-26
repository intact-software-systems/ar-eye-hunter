import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';

import { hashMutationCommand } from '../../protocol/json-wire-identity.ts';
import type { RtcTopologyOutboxWriter } from '../../topology/mutation/rtc-topology-outbox-writer.ts';
import { RtcRttRepository } from '../persistence/rtc-rtt-repository.ts';
import { computeRtcRttMutation } from './compute-rtc-rtt-mutation.ts';
import { readRtcRttMutation } from './read-rtc-rtt-mutation.ts';
import type {
    RtcRttMutationCommand,
    RtcRttMutationComputed,
    RtcRttMutationFacts,
    RtcRttMutationLifecycleFacts,
    RtcRttStableRequest
} from './rtc-rtt-mutation-contracts.ts';
import { validateRtcRttMutation } from './validate-rtc-rtt-mutation.ts';
import { writeRtcRttMutation } from './write-rtc-rtt-mutation.ts';

export interface ExecuteRtcRttMutationResult {
    readonly computed: RtcRttMutationComputed;
    readonly updated: boolean;
}

export interface ExecuteRtcRttMutationInput {
    readonly repository: RtcRttRepository;
    readonly transaction: PSqlSql;
    readonly outboxWriter: RtcTopologyOutboxWriter;
    readFacts: () => RtcRttMutationLifecycleFacts | Promise<RtcRttMutationLifecycleFacts>;
    readonly request: RtcRttStableRequest;
    readCommand: () => RtcRttMutationCommand | Promise<RtcRttMutationCommand>;
    readonly attemptCount: number;
}

export async function executeRtcRttMutation(
    input: ExecuteRtcRttMutationInput
): Promise<ExecuteRtcRttMutationResult> {
    const stableRequest = input.request;
    const commandHash = await hashMutationCommand(stableRequest);
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
    if (facts.requestedAtEpochMs === null || facts.purgeAfterEpochMs === null) {
        throw new TypeError('RTC RTT write is missing lifecycle facts');
    }
    await writeRtcRttMutation({
        transaction: input.transaction,
        repositoryOptions: {
            ttlMs: facts.purgeAfterEpochMs - facts.requestedAtEpochMs,
            now: () => facts.requestedAtEpochMs
        },
        computed,
        outboxWriter: input.outboxWriter
    });
    return { computed, updated: true };
}
