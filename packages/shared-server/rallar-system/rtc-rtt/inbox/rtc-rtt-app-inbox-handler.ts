import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { type AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import { type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import { computeRtcRttMutation } from '../mutation/compute-rtc-rtt-mutation.ts';
import { readRtcRttMutation } from '../mutation/read-rtc-rtt-mutation.ts';
import { validateRtcRttMutation } from '../mutation/validate-rtc-rtt-mutation.ts';
import { writeRtcRttMutation } from '../mutation/write-rtc-rtt-mutation.ts';
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
import { toRtcRttAppInboxResult, type RtcRttAppInboxResult } from './rtc-rtt-app-inbox-result.ts';

export interface RtcRttAppInboxHandlerDependencies {
    readonly groupStateService: GroupStateService;
    readonly writeMutation: (
        context: AppInboxMessageContext<RtcRttAppInboxResult>,
        write: (transaction: PSqlSql) => Promise<RtcRttAppInboxResult>
    ) => Promise<RtcRttAppInboxResult>;
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
        const computed = computeRtcRttMutation({ command, read, facts });
        validateRtcRttMutation({ command, read, facts, computed });
        const result = await this.commitMutation({
            context,
            command: authority.command,
            computed,
            facts,
            mutationDependencies: rtcRttDependencies
        });
        if (computed.outcome === 'write') {
            rtcRttDependencies.observeCommitted?.(computed.measurementGuard.value);
            rtcRttDependencies.outboxWriter.recordCommittedWrites(computed.outboxWrites.length);
            this.dependencies.wakeQueue?.();
            try {
                rtcRttDependencies.formationMetrics?.({
                    topologyEffectCount: computed.affectedGroups.length
                });
            }
            catch {
                // Recording must never affect RTT mutation behavior.
            }
        }
        return result;
    }

    private async commitMutation(input: CommitRtcRttMutationInput): Promise<RtcRttAppInboxResult> {
        const { context, command, computed, facts } = input;
        return await this.dependencies.writeMutation(context, async (transaction) => {
            if (computed.outcome === 'write') {
                if (facts.requestedAtEpochMs === null || facts.purgeAfterEpochMs === null) {
                    throw new TypeError('RTC RTT write lifecycle facts are missing');
                }
                await writeRtcRttMutation({
                    transaction,
                    repositoryOptions: {
                        ttlMs: facts.purgeAfterEpochMs - facts.requestedAtEpochMs,
                        now: () => facts.requestedAtEpochMs
                    },
                    computed,
                    outboxWriter: input.mutationDependencies.outboxWriter
                });
            }
            return toRtcRttAppInboxResult(computed, command.requestId);
        });
    }
}

interface CommitRtcRttMutationInput {
    readonly context: AppInboxMessageContext<RtcRttAppInboxResult>;
    readonly command: RtcRttAppInboxCommand;
    readonly computed: ReturnType<typeof computeRtcRttMutation>;
    readonly facts: Parameters<typeof computeRtcRttMutation>[0]['facts'];
    readonly mutationDependencies: RtcRttAppInboxDependencies;
}
