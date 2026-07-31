import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    requireConditionalWrite,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import type { PSqlSql, PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { runInTransaction } from '../../postgres/run-in-transaction.ts';
import { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    createTransactionBoundGroupStateRepository,
    GroupStateRepository,
} from '../group-state/persistence/group-state-repository.ts';
import { assembleGroupStateSnapshot } from '../group-state/persistence/assemble-group-state-snapshot.ts';
import {
    computeGroupPresenceSummary,
    type GroupPresenceSummaryComputed,
    type GroupPresenceSummaryRead,
    type GroupPresenceSummaryWorkData,
    validateGroupPresenceSummary,
} from './group-state-mutations.ts';
import { computeGroupStateSyncEntries } from '../state-sync-publisher.ts';
import { computeRtcTopologyEntry } from './RtcTopologyOutboxWork.ts';
import { decodeCanonicalGroupPresenceSummaryWork } from './group-presence-summary-work-contract.ts';

export type GroupPresenceSummaryWorkOptions = Readonly<{
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    database?: PSqlSql;
    now?: () => number;
    serviceId: string;
    wakeQueue?: () => void;
    timing?: import('./timing.ts').RallarTimingSink;
}>;

export type GroupPresenceSummaryComputedWork = Readonly<{
    work: GroupPresenceSummaryWorkData;
    summary: GroupPresenceSummaryComputed;
    snapshot: GroupSnapshot;
    downstreamOutboxEntries: readonly ResourceEntry[];
}>;

export class GroupPresenceSummaryWork {
    private readonly now: () => number;

    constructor(private readonly options: GroupPresenceSummaryWorkOptions) {
        this.now = options.now ?? (() => Date.now());
    }

    async read(work: GroupPresenceSummaryWorkData): Promise<GroupPresenceSummaryRead> {
        const repository = new GroupStateRepository(this.options.runtimeRepository);
        const [group, members, admissions, presenceSessions, current] = await Promise.all([
            repository.findGroupEntry(work.aggregateRef),
            repository.listMemberEntries(work.aggregateRef),
            repository.listPresenceAdmissionEntries(work.aggregateRef),
            repository.listPresenceSessionEntries(work.aggregateRef),
            repository.findPresenceSummaryEntry(work.aggregateRef),
        ]);
        if (!group) {
            throw new TypeError(
                `Group not found for presence summary: ${work.aggregateRef.groupId}`,
            );
        }
        return {
            group,
            members,
            admissions,
            presenceSessions,
            current: current ?? null,
        };
    }

    compute(
        work: GroupPresenceSummaryWorkData,
        read: GroupPresenceSummaryRead,
    ): GroupPresenceSummaryComputedWork {
        const summary = computeGroupPresenceSummary({
            ref: work.aggregateRef,
            read,
            nowEpochMs: this.now(),
        });
        const snapshot = assembleGroupStateSnapshot({
            group: read.group.value,
            members: read.members.map((member) => member.value),
            summary: summary.summary,
            authoritativeSessions: read.presenceSessions.map((session) => session.value),
            groupRevision: summary.summary.causalRevision.groupRevision,
            observedAtEpochMs: summary.summary.computedAtEpochMs,
        }, (storageKey, message) => new Error(`${message}: ${storageKey}`));
        const audience = {
            kind: 'group' as const,
            applicationId: work.aggregateRef.applicationId,
            workspaceId: work.aggregateRef.workspaceId,
            resourceId: work.aggregateRef.groupId,
        };
        const eventEntries = computeGroupStateSyncEntries({
            commandId: work.commandId,
            aggregateRef: work.aggregateRef,
            acceptedCausalRevision: work.acceptedCausalRevision,
            audience,
            createdAtEpochMs: work.createdAtEpochMs,
            expireAtEpochMs: work.expireAtEpochMs,
            effects: [{
                effectKind: 'member-state',
                payloadKind: 'event',
                payload: work.event,
            }],
        }, this.options.serviceId);
        const snapshotEntries = computeGroupStateSyncEntries({
            commandId: work.commandId,
            aggregateRef: work.aggregateRef,
            acceptedCausalRevision: snapshot.causalRevision,
            audience,
            createdAtEpochMs: summary.summary.computedAtEpochMs,
            expireAtEpochMs: work.expireAtEpochMs,
            effects: [
                {
                    effectKind: 'member-state',
                    payloadKind: 'snapshot',
                    payload: snapshot,
                },
                {
                    effectKind: 'scope-directory',
                    payloadKind: 'snapshot',
                    payload: snapshot,
                },
            ],
        }, this.options.serviceId);
        const topologyEntry = computeRtcTopologyEntry({
            commandId: work.commandId,
            aggregateRef: work.aggregateRef,
            acceptedCausalRevision: snapshot.causalRevision,
            groupSnapshot: snapshot,
            effectKind: 'rtc-topology-recompute',
            payloadKind: 'group-revision',
            requestOptions: toCanonicalGroupTopologyConfigPatch({}),
            publish: true,
            createdAtEpochMs: summary.summary.computedAtEpochMs,
            expireAtEpochMs: work.expireAtEpochMs,
        }, this.options.serviceId);
        return {
            work,
            summary,
            snapshot,
            downstreamOutboxEntries: [...eventEntries, ...snapshotEntries, topologyEntry],
        };
    }

    validate(
        work: GroupPresenceSummaryWorkData,
        read: GroupPresenceSummaryRead,
        computed: GroupPresenceSummaryComputedWork,
    ): void {
        if (computed.work !== work) {
            throw new TypeError('Presence-summary computed work differs from its command');
        }
        validateGroupPresenceSummary({
            ref: work.aggregateRef,
            read,
            computed: computed.summary,
        });
        if (
            work.event.applicationId !== work.aggregateRef.applicationId ||
            work.event.workspaceId !== work.aggregateRef.workspaceId ||
            work.event.groupId !== work.aggregateRef.groupId ||
            work.event.causalRevision.groupRevision !==
                work.acceptedCausalRevision.groupRevision ||
            work.event.causalRevision.presenceRevision !==
                work.acceptedCausalRevision.presenceRevision
        ) {
            throw new TypeError('Presence-summary event differs from accepted group revision');
        }
    }

    async write(
        transaction: PSqlTransactionSql,
        computed: GroupPresenceSummaryComputedWork,
    ): Promise<void> {
        const repository = createTransactionBoundGroupStateRepository(transaction);
        if (computed.summary.outcome === 'write') {
            requireConditionalWrite(
                computed.summary.operation === 'insert'
                    ? await repository.insertPresenceSummary(computed.summary.summary)
                    : await repository.updatePresenceSummary(
                        computed.summary.summary,
                        computed.summary.expectedRevision!,
                    ),
            );
        }
        const outbox = new ResourceInboxRepository(transaction);
        for (const entry of computed.downstreamOutboxEntries) {
            await outbox.writeIfAbsentOrMatch(entry);
        }
    }

    async processReservedEntry(
        message: ALMessage,
        entry: ResourceEntry,
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
                new Date(this.now()),
            );
            if (!finished) {
                throw new Error('Presence-summary reservation changed before commit');
            }
        });
        this.options.wakeQueue?.();
    }
}

export function toGroupPresenceSummaryQueueContextId(ref: GroupRef): string {
    return JSON.stringify([ref.applicationId, ref.workspaceId, ref.groupId]);
}
