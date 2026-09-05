import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { GROUP_MINIMUM_LAYOUT_AGE_MS } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import { writeResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { writeAppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { writeCoalescedAppOutboxWork } from '../../app-outbox/coalesced-app-outbox-work.ts';
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
import { assertGroupPresenceSummaryRead } from './assert-group-presence-summary-read.ts';
import { decodeCanonicalGroupPresenceSummaryWork } from './decode-canonical-group-presence-summary-work.ts';
import {
    computeGroupPresenceSummaryWork,
    toTopologyReplanEnqueueFacts,
    validateGroupPresenceSummaryComputedWork,
    type GroupPresenceSummaryComputedWork,
    type GroupPresenceSummaryReservationRead,
    type GroupPresenceSummaryWorkRead,
    type GroupPresenceSummaryWrite
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
    private readonly options: GroupPresenceSummaryWorkOptions;

    public constructor(options: GroupPresenceSummaryWorkOptions) {
        this.options = options;
        this.now = options.now ?? Date.now;
    }

    public async read(
        work: GroupPresenceSummaryWorkData,
        reservation: GroupPresenceSummaryReservationRead,
        nowEpochMs: number
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
        const read: GroupPresenceSummaryWorkRead = {
            nowEpochMs,
            reservation: {
                key: { ...reservation.key },
                expectedAttempts: reservation.expectedAttempts
            },
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
                coalescedTopologyEntry,
                nowEpochMs
            )
        };
        assertGroupPresenceSummaryRead(work.aggregateRef, read.presence);
        return read;
    }

    /** The policy and planned slot are read only when the enqueue gate will consult them. */
    private async readTopologyReplanPolicyFacts(
        work: GroupPresenceSummaryWorkData,
        group: Group,
        coalescedTopologyEntry: ResourceEntry | null,
        nowEpochMs: number
    ): Promise<TopologyReplanPolicyFacts> {
        const facts = toTopologyReplanEnqueueFacts(work, group, { coalescedTopologyEntry, nowEpochMs });
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
            recomputeDebounceMs: this.options.recomputeDebounceMs,
            minimumLayoutAgeMs: GROUP_MINIMUM_LAYOUT_AGE_MS
        });
    }

    public validate(
        work: GroupPresenceSummaryWorkData,
        read: GroupPresenceSummaryWorkRead,
        computed: GroupPresenceSummaryComputedWork
    ): ReturnType<typeof validateGroupPresenceSummaryComputedWork> {
        return validateGroupPresenceSummaryComputedWork({
            work,
            read,
            computed,
            options: {
                serviceId: this.options.serviceId,
                recomputeDebounceMs: this.options.recomputeDebounceMs,
                minimumLayoutAgeMs: GROUP_MINIMUM_LAYOUT_AGE_MS
            }
        });
    }

    public async write(
        transaction: PSqlSql,
        computed: GroupPresenceSummaryComputedWork
    ): Promise<void> {
        if (computed.summaryWrite !== null) {
            await writePresenceSummary(transaction, computed.summaryWrite);
        }
        for (const outboxWrite of computed.downstreamOutboxWrites) {
            await writeAppOutboxInsert(transaction, outboxWrite);
        }
        if (computed.topologyReplan.decision === 'enqueue') {
            await writeCoalescedAppOutboxWork(
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
        const read = await this.read(work, {
            key: entry.key,
            expectedAttempts: entry.dequeueAudit.attempts
        }, this.now());
        const computed = this.compute(work, read);
        this.assertValid(work, read, computed);
        await runInPSqlTransaction(this.options.database, async (transaction) => {
            await this.write(transaction, computed);
            const finished = await writeResourceInboxReservationFinish(
                transaction,
                computed.reservationFinish
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

    private assertValid(
        work: GroupPresenceSummaryWorkData,
        read: GroupPresenceSummaryWorkRead,
        computed: GroupPresenceSummaryComputedWork
    ): void {
        const issue = this.validate(work, read, computed)[0];
        if (issue !== undefined) {
            throw issue.cause;
        }
    }

    private recordFormationMetrics(computed: GroupPresenceSummaryComputedWork): void {
        try {
            this.options.formationMetrics?.({
                downstreamTopicIds: [
                    ...computed.downstreamOutboxWrites.map((write) => write.entry.key.topicId),
                    ...(computed.topologyReplan.decision === 'enqueue' ? [APP_OUTBOX_RTC_TOPOLOGY_TOPIC] : [])
                ]
            });
        }
        catch {
            // Metrics recording must not affect the committed queue work.
        }
    }
}

async function writePresenceSummary(
    transaction: PSqlSql,
    computed: GroupPresenceSummaryWrite
): Promise<void> {
    const rows = computed.operation === 'insert'
        ? await transaction<{ revision: number; }[]>`
            insert into runtime_state_store (store_namespace, store_key, store_value,
                                             expire_at_ts, updated_ts, revision)
            values (${computed.namespace}, ${computed.key}, ${computed.value},
                    ${computed.expireAtIsoTimestamp}, now(), 0)
            on conflict (store_namespace, store_key) do nothing
            returning revision
        `
        : await transaction<{ revision: number; }[]>`
            update runtime_state_store
            set store_value = ${computed.value},
                expire_at_ts = ${computed.expireAtIsoTimestamp},
                updated_ts = now(),
                revision = revision + 1
            where store_namespace = ${computed.namespace}
              and store_key = ${computed.key}
              and revision = ${computed.expectedRevision}
            returning revision
        `;
    if (rows.length !== 1) {
        throw new Error('Presence summary changed before write');
    }
}
