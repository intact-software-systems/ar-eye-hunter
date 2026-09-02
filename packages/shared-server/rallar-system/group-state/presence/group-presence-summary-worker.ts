import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import { PSqlResourceInboxEntryRepository } from '../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { PSqlResourceInboxFinalizationRepository } from '../../../queuebox/postgres/p-sql-resource-inbox-finalization-repository.ts';
import { requireConditionalWrite } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { CoalescedAppOutboxWorkService } from '../../app-outbox/coalesced-app-outbox-work-service.ts';
import type { GroupFormationPresenceSummarySink } from '../../observability/formation-metrics.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '../../topology/mutation/rtc-topology-outbox-entry.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../../topology/persistence/rtc-topology-errors.ts';
import { RtcTopologySnapshotRepository } from '../../topology/persistence/rtc-topology-snapshot-repository.ts';
import {
    consultsTopologyReplanPolicy,
    type TopologyReplanPolicyFacts
} from '../../topology/planning/resolve-topology-plan-action.ts';
import {
    toRtcTopologyCoalescedGroupRevisionResourceId
} from '../../topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupLifecyclePolicyRepository } from '../persistence/group-lifecycle-policy-repository.ts';
import { GroupStateRepositoryReads } from '../persistence/group-state-repository-reads.ts';
import { createTransactionBoundGroupStateRepository } from '../persistence/group-state-repository.ts';
import { decodeCanonicalGroupPresenceSummaryWork } from './decode-canonical-group-presence-summary-work.ts';
import {
    computeGroupPresenceSummaryWork,
    toTopologyReplanEnqueueFacts,
    validateGroupPresenceSummaryComputedWork,
    type GroupPresenceSummaryComputedWork,
    type GroupPresenceSummaryWorkRead
} from './group-presence-summary-effects.ts';

export interface GroupPresenceSummaryWorkOptions {
    readonly runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly recomputeDebounceMs: number;
    readonly database?: PSqlSql;
    readonly now?: () => number;
    readonly serviceId: string;
    readonly wakeQueue?: () => void;
    readonly formationMetrics?: GroupFormationPresenceSummarySink;
}

export class GroupPresenceSummaryWork {
    private readonly now: () => number;
    private readonly coalescedTopologyWorkService: CoalescedAppOutboxWorkService;
    private readonly options: GroupPresenceSummaryWorkOptions;

    public constructor(options: GroupPresenceSummaryWorkOptions) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.coalescedTopologyWorkService = new CoalescedAppOutboxWorkService(
            options.outboxQueueReader,
            options.serviceId,
            this.now
        );
    }

    public async read(
        work: GroupPresenceSummaryWorkData
    ): Promise<GroupPresenceSummaryWorkRead> {
        const repository = new GroupStateRepositoryReads(this.options.runtimeRepository);
        const [group, members, admissions, presenceSessions, current, coalescedTopologyEntry] = await Promise.all([
            repository.findGroupEntry(work.aggregateRef),
            repository.listMemberEntries(work.aggregateRef),
            repository.listPresenceAdmissionEntries(work.aggregateRef),
            repository.listPresenceSessionEntries(work.aggregateRef),
            repository.findPresenceSummaryEntry(work.aggregateRef),
            this.readCoalescedTopologyEntry(work.aggregateRef)
        ]);
        if (!group) {
            throw new TypeError(
                `Group not found for presence summary: ${work.aggregateRef.groupId}`
            );
        }
        return {
            presence: {
                group,
                members,
                admissions,
                presenceSessions,
                current: current ?? null
            },
            coalescedTopologyEntry,
            topologyReplanPolicyFacts: await this.readTopologyReplanPolicyFacts(
                work,
                group.value,
                coalescedTopologyEntry
            )
        };
    }

    /** The policy and planned slot are read only when the enqueue gate will consult them. */
    private async readTopologyReplanPolicyFacts(
        work: GroupPresenceSummaryWorkData,
        group: Group,
        coalescedTopologyEntry: ResourceEntry | null
    ): Promise<TopologyReplanPolicyFacts> {
        const facts = toTopologyReplanEnqueueFacts(work, group, { coalescedTopologyEntry, nowEpochMs: this.now() });
        if (!consultsTopologyReplanPolicy(facts)) {
            return { consulted: false };
        }
        const [lifecyclePolicy, plannedLayout] = await Promise.all([
            new GroupLifecyclePolicyRepository(this.options.runtimeRepository).readPolicy(work.aggregateRef),
            this.readPlannedLayoutForGate(work.aggregateRef)
        ]);
        return { consulted: true, lifecyclePolicy, plannedLayout };
    }

    private async readPlannedLayoutForGate(ref: GroupRef): Promise<RallarOverlayTopologySnapshot | null> {
        try {
            return await new RtcTopologySnapshotRepository(this.options.runtimeRepository).findSnapshot(ref) ?? null;
        }
        catch (error) {
            // A corrupt planned row fails the planner's own cycle, not the presence
            // summary: the gate sees no planned layout and lets the cycle surface it.
            if (error instanceof RtcTopologyRepositoryInvariantCorruptionError) {
                return null;
            }
            throw error;
        }
    }

    public compute(
        work: GroupPresenceSummaryWorkData,
        read: GroupPresenceSummaryWorkRead
    ): GroupPresenceSummaryComputedWork {
        return computeGroupPresenceSummaryWork(work, read, {
            serviceId: this.options.serviceId,
            nowEpochMs: this.now(),
            recomputeDebounceMs: this.options.recomputeDebounceMs
        });
    }

    public validate(
        work: GroupPresenceSummaryWorkData,
        read: GroupPresenceSummaryWorkRead,
        computed: GroupPresenceSummaryComputedWork
    ): void {
        validateGroupPresenceSummaryComputedWork({
            work,
            read,
            computed,
            options: {
                serviceId: this.options.serviceId,
                recomputeDebounceMs: this.options.recomputeDebounceMs
            }
        });
    }

    public async write(
        transaction: PSqlSql,
        computed: GroupPresenceSummaryComputedWork
    ): Promise<void> {
        const repository = createTransactionBoundGroupStateRepository(transaction);
        if (computed.summary.outcome === 'write') {
            requireConditionalWrite(
                computed.summary.operation === 'insert'
                    ? await repository.insertPresenceSummary(computed.summary.summary)
                    : await repository.updatePresenceSummary(
                        computed.summary.summary,
                        computed.summary.expectedRevision!
                    )
            );
        }
        const outbox = new PSqlResourceInboxEntryRepository(transaction);
        for (const entry of computed.downstreamOutboxEntries) {
            await outbox.writeIfAbsentOrMatch(entry);
        }
        if (computed.topologyReplan.decision === 'enqueue') {
            await this.coalescedTopologyWorkService.write(
                transaction,
                computed.topologyReplan.work
            );
        }
    }

    public async processReservedEntry(
        message: ALMessage,
        entry: ResourceEntry
    ): Promise<void> {
        if (!this.options.database) {
            throw new TypeError('Presence-summary queue processing requires a database');
        }
        const work = decodeCanonicalGroupPresenceSummaryWork(message, entry);
        const read = await this.read(work);
        const computed = this.compute(work, read);
        this.validate(work, read, computed);
        await runInPSqlTransaction(this.options.database, async (transaction) => {
            await this.write(transaction, computed);
            const finished = await new PSqlResourceInboxFinalizationRepository(transaction).finishReserved(
                entry.key,
                entry.dequeueAudit.attempts,
                EntityStatus.COMPLETED,
                new Date(this.now())
            );
            if (!finished) {
                throw new Error('Presence-summary reservation changed before commit');
            }
        });
        this.options.wakeQueue?.();
        this.recordFormationMetrics(computed);
    }

    private async readCoalescedTopologyEntry(ref: GroupRef): Promise<ResourceEntry | null> {
        const key = toAppQueueKey({
            topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
            resourceId: toRtcTopologyCoalescedGroupRevisionResourceId(toScopedOverlayId(ref)),
            contextId: groupStateGroupStorageKey(ref)
        });
        return (await this.options.outboxQueueReader.outbox.getItem(key)) ?? null;
    }

    private recordFormationMetrics(computed: GroupPresenceSummaryComputedWork): void {
        try {
            this.options.formationMetrics?.({
                downstreamTopicIds: [
                    ...computed.downstreamOutboxEntries.map((entry) => entry.key.topicId),
                    ...(computed.topologyReplan.decision === 'enqueue' ? [APP_OUTBOX_RTC_TOPOLOGY_TOPIC] : [])
                ]
            });
        }
        catch {
            // Metrics recording must not affect the committed queue work.
        }
    }
}
