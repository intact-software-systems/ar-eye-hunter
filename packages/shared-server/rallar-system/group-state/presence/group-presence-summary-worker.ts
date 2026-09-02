import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import { writeResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { requireConditionalWrite } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { writeAppOutboxInsertOrMatch } from '../../app-outbox/app-outbox-insert.ts';
import { writeCoalescedAppOutboxWork } from '../../app-outbox/coalesced-app-outbox-work.ts';
import type { GroupFormationPresenceSummarySink } from '../../observability/formation-metrics.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '../../topology/mutation/rtc-topology-outbox-entry.ts';
import {
    toRtcTopologyCoalescedGroupRevisionResourceId
} from '../../topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import type { GroupStateValidationIssue } from '../group-state-validation-issues.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepositoryReads } from '../persistence/group-state-repository-reads.ts';
import { decodeCanonicalGroupPresenceSummaryWork } from './decode-canonical-group-presence-summary-work.ts';
import {
    computeGroupPresenceSummaryWork,
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
    private readonly options: GroupPresenceSummaryWorkOptions;

    public constructor(options: GroupPresenceSummaryWorkOptions) {
        this.options = options;
        this.now = options.now ?? Date.now;
    }

    public async read(
        work: GroupPresenceSummaryWorkData,
        entry: ResourceEntry
    ): Promise<GroupPresenceSummaryWorkRead> {
        const repository = new GroupStateRepositoryReads(this.options.runtimeRepository);
        const [presence, coalescedTopologyEntry] = await Promise.all([
            repository.readGroupPresenceSummary(work.aggregateRef),
            this.readCoalescedTopologyEntry(work.aggregateRef)
        ]);
        if (!presence) {
            throw new TypeError(
                `Group not found for presence summary: ${work.aggregateRef.groupId}`
            );
        }
        return {
            presence,
            coalescedTopologyEntry,
            nowEpochMs: this.now(),
            serviceId: this.options.serviceId,
            recomputeDebounceMs: this.options.recomputeDebounceMs,
            reservation: {
                key: entry.key,
                expectedAttempts: entry.dequeueAudit.attempts
            }
        };
    }

    public compute(
        work: GroupPresenceSummaryWorkData,
        read: GroupPresenceSummaryWorkRead
    ): GroupPresenceSummaryComputedWork {
        return computeGroupPresenceSummaryWork(work, read);
    }

    public validate(
        work: GroupPresenceSummaryWorkData,
        read: GroupPresenceSummaryWorkRead,
        computed: GroupPresenceSummaryComputedWork
    ): readonly GroupStateValidationIssue[] {
        return validateGroupPresenceSummaryComputedWork({
            work,
            read,
            computed
        });
    }

    public async write(
        transaction: PSqlSql,
        computed: GroupPresenceSummaryComputedWork
    ): Promise<void> {
        const summaryWrite = computed.summaryWrite;
        if (summaryWrite) {
            const repository = new PSqlRuntimeStateRepository(transaction);
            requireConditionalWrite(
                summaryWrite.expectedRevision === null
                    ? await repository.insertIfAbsent(
                        summaryWrite.namespace,
                        summaryWrite.key,
                        summaryWrite.value,
                        summaryWrite.expireAtIsoTimestamp
                    )
                    : await repository.upsertIfRevision(
                        summaryWrite.namespace,
                        summaryWrite.key,
                        summaryWrite.value,
                        summaryWrite.expireAtIsoTimestamp,
                        summaryWrite.expectedRevision
                    )
            );
        }
        for (const outboxWrite of computed.downstreamOutboxWrites) {
            await writeAppOutboxInsertOrMatch(transaction, outboxWrite);
        }
        await writeCoalescedAppOutboxWork(
            transaction,
            computed.coalescedTopologyWork
        );
        const finished = await writeResourceInboxReservationFinish(
            transaction,
            computed.reservationFinish
        );
        if (!finished) {
            throw new Error('Presence-summary reservation changed before commit');
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
        const read = await this.read(work, entry);
        const computed = this.compute(work, read);
        const issues = this.validate(work, read, computed);
        if (issues.length > 0) {
            throw issues[0].cause;
        }
        await runInPSqlTransaction(this.options.database, async (transaction) => {
            await this.write(transaction, computed);
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
                    ...computed.downstreamOutboxWrites.map((outboxWrite) => outboxWrite.entry.key.topicId),
                    APP_OUTBOX_RTC_TOPOLOGY_TOPIC
                ]
            });
        }
        catch {
            // Metrics recording must not affect the committed queue work.
        }
    }
}
