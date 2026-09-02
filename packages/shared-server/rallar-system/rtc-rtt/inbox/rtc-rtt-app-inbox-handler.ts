import type { AppInboxEnqueueInput, AppInboxExecutionMetadata } from '../../app-inbox/app-inbox-contracts.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import { readRtcRttMutation } from '../mutation/read-rtc-rtt-mutation.ts';
import { writeRtcRttMutation } from '../mutation/write-rtc-rtt-mutation.ts';
import {
    computeRtcRttAppInboxMutation,
    validateRtcRttAppInboxMutation,
    type RtcRttAppInboxComputed,
    type RtcRttAppInboxRead
} from './compute-rtc-rtt-app-inbox-mutation.ts';
import {
    createRtcRttDurableEnqueue,
    decodeRtcRttAppInboxAuthority,
    verifyRtcRttAppInboxAuthority
} from './rtc-rtt-app-inbox-authority.ts';
import type {
    CreateRtcRttAppInboxEnqueueInput,
    RtcRttAppInboxCommand,
    RtcRttAppInboxDependencies
} from './rtc-rtt-app-inbox-contracts.ts';
import type { RtcRttAppInboxResult } from './rtc-rtt-app-inbox-result.ts';

export interface RtcRttAppInboxHandlerDependencies {
    readonly groupStateService: GroupStateService;
    readonly transactionWriter: AppInboxMutationTransactionWriter;
    readonly nowEpochMs: () => number;
    readonly wakeQueue?: () => void;
}

export class RtcRttAppInboxHandler {
    private readonly dependencies: RtcRttAppInboxHandlerDependencies;

    constructor(dependencies: RtcRttAppInboxHandlerDependencies) {
        this.dependencies = dependencies;
    }

    async createEnqueue(
        input: CreateRtcRttAppInboxEnqueueInput
    ): Promise<AppInboxEnqueueInput> {
        return await createRtcRttDurableEnqueue({
            request: input,
            groupStateService: this.dependencies.groupStateService,
            nowEpochMs: this.dependencies.nowEpochMs
        });
    }

    async processMutation(
        context: AppInboxExecutionMetadata,
        rtcRttDependencies: RtcRttAppInboxDependencies
    ): Promise<RtcRttAppInboxResult> {
        const authority = decodeRtcRttAppInboxAuthority(context.enqueue.authority);
        await verifyRtcRttAppInboxAuthority({
            authority,
            groupStateService: this.dependencies.groupStateService,
            nowEpochMs: this.dependencies.nowEpochMs
        });
        const read = await this.readMutation(context, authority.command, rtcRttDependencies);
        const computed = computeRtcRttAppInboxMutation(read);
        const issues = validateRtcRttAppInboxMutation(read, computed);
        if (issues.length > 0) {
            throw issues[0]!.cause;
        }
        const result = await this.commitMutation(context, computed, rtcRttDependencies);
        if (computed.mutation.outcome === 'write') {
            rtcRttDependencies.observeCommitted?.(computed.mutation.measurementGuard.value);
            this.dependencies.wakeQueue?.();
            try {
                rtcRttDependencies.formationMetrics?.({
                    topologyEffectCount: computed.mutation.affectedGroups.length
                });
            }
            catch {
                // Recording must never affect RTT mutation behavior.
            }
        }
        return result;
    }

    private async readMutation(
        context: AppInboxExecutionMetadata,
        inboxCommand: RtcRttAppInboxCommand,
        rtcRttDependencies: RtcRttAppInboxDependencies
    ): Promise<RtcRttAppInboxRead> {
        const stableRequest = {
            rtt: inboxCommand.rtt,
            alSenderId: inboxCommand.actor.sessionId
        };
        const read = await readRtcRttMutation(rtcRttDependencies.repository, stableRequest);
        const attemptCount = context.entry.dequeueAudit.attempts;
        const command = read.receipt
            ? {
                ...stableRequest,
                candidateGroups: null,
                overlaySnapshotsByGroupKey: null,
                degreeLimit: null
            }
            : {
                ...stableRequest,
                ...(await rtcRttDependencies.readPolicyInputs(inboxCommand))
            };
        const lifecycleFacts = read.receipt
            ? { requestedAtEpochMs: null, purgeAfterEpochMs: null }
            : await rtcRttDependencies.repository.readMutationFacts();
        return {
            requestId: inboxCommand.requestId,
            command,
            mutationRead: read,
            facts: {
                ...lifecycleFacts,
                commandHash: inboxCommand.mutationCommandHash,
                attemptCount
            },
            completionFacts: this.dependencies.transactionWriter.readCompletionFacts(context)
        };
    }

    private async commitMutation(
        context: AppInboxExecutionMetadata,
        computed: RtcRttAppInboxComputed,
        mutationDependencies: RtcRttAppInboxDependencies
    ): Promise<RtcRttAppInboxResult> {
        const durableResult = await this.dependencies.transactionWriter.writeMutation(
            context,
            computed.completion,
            async (transaction) => {
                if (computed.mutation.outcome !== 'write') {
                    return;
                }
                await writeRtcRttMutation({
                    transaction,
                    computed: computed.mutation
                });
            }
        );
        if (computed.mutation.outcome === 'write') {
            mutationDependencies.outboxWriter.recordCommitted(
                computed.mutation.outboxWrites.length
            );
        }
        return durableResult;
    }
}
