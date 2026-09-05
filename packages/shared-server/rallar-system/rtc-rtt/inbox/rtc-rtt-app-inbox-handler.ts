import type { AppInboxEnqueueInput, AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import { readRtcRttMutation } from '../mutation/read-rtc-rtt-mutation.ts';
import { writeRtcRttMutation } from '../mutation/write-rtc-rtt-mutation.ts';
import {
    createRtcRttDurableEnqueue,
    decodeRtcRttAppInboxAuthority,
    verifyRtcRttAppInboxAuthority
} from './rtc-rtt-app-inbox-authority.ts';
import {
    computeRtcRttAppInboxMutation,
    validateRtcRttAppInboxMutation,
    type RtcRttAppInboxMutationComputed
} from './rtc-rtt-app-inbox-computation.ts';
import type {
    CreateRtcRttAppInboxEnqueueInput,
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
        context: AppInboxMessageContext<RtcRttAppInboxResult>,
        rtcRttDependencies: RtcRttAppInboxDependencies
    ): Promise<RtcRttAppInboxResult> {
        const authority = decodeRtcRttAppInboxAuthority(context.enqueue.authority);
        await verifyRtcRttAppInboxAuthority({
            authority,
            groupStateService: this.dependencies.groupStateService,
            nowEpochMs: this.dependencies.nowEpochMs
        });
        const completionFacts = this.dependencies.transactionWriter.readCompletionFacts(context);
        const stableRequest = {
            rtt: authority.command.rtt,
            alSenderId: authority.command.actor.sessionId
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
                ...(await rtcRttDependencies.readPolicyInputs(authority.command))
            };
        const lifecycleFacts = read.receipt
            ? { requestedAtEpochMs: null, purgeAfterEpochMs: null }
            : await rtcRttDependencies.repository.readMutationFacts();
        const facts = {
            ...lifecycleFacts,
            commandHash: authority.command.mutationCommandHash,
            attemptCount
        };
        const computationInput = {
            command,
            read,
            facts,
            requestId: authority.command.requestId,
            completionFacts
        };
        const computed = computeRtcRttAppInboxMutation(computationInput);
        const validationIssue = validateRtcRttAppInboxMutation(computationInput, computed)[0];
        if (validationIssue !== undefined) {
            throw validationIssue.cause;
        }
        const result = await this.commitMutation({
            context,
            computed,
            mutationDependencies: rtcRttDependencies
        });
        if (computed.mutation.outcome === 'write') {
            rtcRttDependencies.observeCommitted?.(computed.mutation.measurementGuard.value);
            rtcRttDependencies.outboxWriter.recordCommittedWrites(computed.mutation.outboxWrites.length);
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

    private async commitMutation(input: CommitRtcRttMutationInput): Promise<RtcRttAppInboxResult> {
        const { context, computed } = input;
        return await this.dependencies.transactionWriter.writeComputedMutation(
            context,
            computed.completion,
            async (transaction) => {
                if (computed.mutation.outcome === 'write') {
                    await writeRtcRttMutation({
                        transaction,
                        computed: computed.mutation,
                        outboxWriter: input.mutationDependencies.outboxWriter
                    });
                }
            }
        );
    }
}

interface CommitRtcRttMutationInput {
    readonly context: AppInboxMessageContext<RtcRttAppInboxResult>;
    readonly computed: RtcRttAppInboxMutationComputed;
    readonly mutationDependencies: RtcRttAppInboxDependencies;
}
