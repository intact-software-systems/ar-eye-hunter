import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { PSqlSql, PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../../../postgres/resource-inbox/ResourceInboxRepository.ts';
import { runInTransaction } from '../../../postgres/run-in-transaction.ts';
import { requireConditionalWrite } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../../runtime-state/RuntimeStateRepository.ts';
import { CoalescedAppOutboxWorkService } from '../../app-outbox/coalesced-app-outbox-work-service.ts';
import type { GroupFormationPresenceSummarySink } from '../../observability/formation-metrics.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '../../topology/mutation/rtc-topology-outbox-entry.ts';
import {
    toRtcTopologyCoalescedGroupRevisionResourceId
} from '../../topology/replay/rtc-topology-coalesced-group-revision-work.ts';
import {
    createTransactionBoundGroupStateRepository,
    GroupStateRepository
} from '../persistence/group-state-repository.ts';
import { groupStateGroupStorageKey } from '../persistence/group-state-storage-keys.ts';
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
        const repository = new GroupStateRepository(this.options.runtimeRepository);
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
            coalescedTopologyEntry
        };
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
        transaction: PSqlTransactionSql,
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
        const outbox = new ResourceInboxRepository(transaction);
        for (const entry of computed.downstreamOutboxEntries) {
            await outbox.writeIfAbsentOrMatch(entry);
        }
        await this.coalescedTopologyWorkService.write(
            transaction,
            computed.coalescedTopologyWork
        );
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
        await runInTransaction(this.options.database, async (transaction) => {
            await this.write(transaction, computed);
            const finished = await new ResourceInboxRepository(transaction).finishReserved(
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
                    APP_OUTBOX_RTC_TOPOLOGY_TOPIC
                ]
            });
        }
        catch {
            // Metrics recording must not affect the committed queue work.
        }
    }
}
