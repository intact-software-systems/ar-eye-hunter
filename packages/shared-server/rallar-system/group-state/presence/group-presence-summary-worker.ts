import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { GROUP_MINIMUM_LAYOUT_AGE_MS } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import {
    isCanonicalGroupPresenceSummaryEntry,
    type GroupPresenceSummaryWorkData
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { ResourceInboxHandlerRetryableConflict } from '@shared/queuebox/resource-inbox/resource-inbox-handler-outcome.ts';
import { EntityStatus, isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import { writeResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { writeAppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { writeCoalescedAppOutboxWork } from '../../app-outbox/coalesced-app-outbox-work.ts';
import type { GroupFormationPresenceSummarySink } from '../../observability/formation-metrics.ts';
import {
    nowMs,
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingDetails,
    type RallarTimingSink
} from '../../observability/timing.ts';
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
import {
    assertGroupPresenceSummaryRead,
    validateGroupPresenceSummaryReadConsistency,
    type GroupPresenceSummaryReadInconsistency
} from './assert-group-presence-summary-read.ts';
import {
    computeGroupPresenceSummaryCoalescedWrite,
    validateGroupPresenceSummaryCoalescedWrite,
    type GroupPresenceSummaryCoalescedWrite
} from './compute-group-presence-summary-coalesced-write.ts';
import { decodeCanonicalGroupPresenceSummaryWork } from './decode-canonical-group-presence-summary-work.ts';
import {
    computeGroupDeltaProvenance,
    writeGroupDeltaProvenance,
    type GroupDeltaProvenanceInsert
} from './group-delta-provenance.ts';
import {
    computeGroupPresenceSummaryWork,
    toTopologyReplanEnqueueFacts,
    validateGroupPresenceSummaryComputedWork,
    type GroupPresenceSummaryComputedWork,
    type GroupPresenceSummaryReservationRead,
    type GroupPresenceSummaryWorkRead
} from './group-presence-summary-effects.ts';
import {
    recordGroupPresenceSummaryCommittedOutputs,
    toGroupPresenceSummaryTimingEvent,
    type GroupPresenceSummaryTiming
} from './group-presence-summary-timing.ts';

export interface GroupPresenceSummaryWorkOptions {
    readonly runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly recomputeDebounceMs: number;
    readonly recomputeMaxWaitMs: number;
    readonly database?: PSqlSql;
    readonly now: () => number;
    readonly serviceId: string;
    readonly wakeQueue?: () => void;
    readonly formationMetrics?: GroupFormationPresenceSummarySink;
    readonly timing?: RallarTimingSink;
}

/** One summary work row and the reservation its finish must match. */
export interface GroupPresenceSummaryWorkItem {
    readonly work: GroupPresenceSummaryWorkData;
    readonly reservation: GroupPresenceSummaryReservationRead;
}

interface GroupPresenceSummaryExpansion {
    readonly work: GroupPresenceSummaryWorkData;
    readonly read: GroupPresenceSummaryWorkRead;
    readonly computed: GroupPresenceSummaryComputedWork;
}

interface ReadTopologyReplanPolicyFactsInput {
    readonly work: GroupPresenceSummaryWorkData;
    readonly group: GroupPresenceSummaryWorkRead['presence']['group']['value'];
    readonly coalescedTopologyEntry: ResourceEntry | null;
    readonly nowEpochMs: number;
}

interface RecordGroupPresenceSummaryPhaseInput {
    readonly work: GroupPresenceSummaryWorkData;
    readonly operation: GroupPresenceSummaryTiming.Phase;
    readonly details: RallarTimingDetails;
    readonly startedAtMs: number;
}

type GroupPresenceSummaryWriteOutcome = 'written' | 'summary-changed';

/**
 * Another server summarised the group between this attempt's read and its write (D304). The next attempt reads the
 * fresh rows and recomputes, so it cannot repeat the lost write: its retry is capped at this, not the queue's backoff,
 * which reaches 1–8 s from the sixth attempt. The early backoff stays shorter, and the attempt budget still bounds it.
 */
export const GROUP_PRESENCE_SUMMARY_CONFLICT_RETRY_DELAY_MS = 100;

/** The queue caps a work page at 256 rows; one page of pending APP_OUTBOX work is scanned per expansion. */
const COALESCED_SUMMARY_WORK_SCAN_LIMIT = 256;

export class GroupPresenceSummaryWork {
    private readonly now: () => number;
    private readonly options: GroupPresenceSummaryWorkOptions;

    public constructor(options: GroupPresenceSummaryWorkOptions) {
        this.options = options;
        this.now = options.now;
    }

    /**
     * One read of the group serves every item of the same group; the items differ only in their
     * reservation. Rows that contradict each other come back as a typed inconsistency (D295).
     */
    public async read(
        items: readonly GroupPresenceSummaryWorkItem[],
        nowEpochMs: number
    ): Promise<Either<GroupPresenceSummaryReadInconsistency, readonly GroupPresenceSummaryWorkRead[]>> {
        const first = requireSameGroup(items);
        const ref = first.work.aggregateRef;
        const repository = new GroupStateRepositoryReads(this.options.runtimeRepository);
        const [stored, coalescedTopologyEntry] = await Promise.all([
            repository.readPresenceSummaryEntries(ref),
            this.readCoalescedTopologyEntry(ref)
        ]);
        if (stored.status === 'concurrent-change') {
            return Either.ofLeft({
                code: 'group-presence-summary-concurrent-change',
                message: 'Group presence summary rows changed while they were read'
            });
        }
        if (!stored.group) {
            throw new TypeError(`Group not found for presence summary: ${ref.groupId}`);
        }
        const presence = {
            group: stored.group,
            members: stored.members,
            admissions: stored.admissions,
            presenceSessions: stored.presenceSessions,
            current: stored.current ?? null
        };
        assertGroupPresenceSummaryRead(ref, presence);
        const inconsistency = validateGroupPresenceSummaryReadConsistency(presence)[0];
        if (inconsistency !== undefined) {
            return Either.ofLeft(inconsistency);
        }
        const coalescedEvents = items.map((item) => item.work.event);
        const topologyReplanPolicyFacts = await this.readTopologyReplanPolicyFacts({
            work: first.work,
            group: presence.group.value,
            coalescedTopologyEntry,
            nowEpochMs
        });
        return Either.ofRight(items.map((item) => ({
            nowEpochMs,
            reservation: {
                key: { ...item.reservation.key },
                expectedAttempts: item.reservation.expectedAttempts
            },
            presence,
            coalescedEvents,
            coalescedTopologyEntry,
            topologyReplanPolicyFacts
        })));
    }

    private async readTopologyReplanPolicyFacts(
        input: ReadTopologyReplanPolicyFactsInput
    ): Promise<TopologyReplanPolicyFacts> {
        const { work, group, coalescedTopologyEntry, nowEpochMs } = input;
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
            recomputeMaxWaitMs: this.options.recomputeMaxWaitMs,
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
                recomputeMaxWaitMs: this.options.recomputeMaxWaitMs,
                minimumLayoutAgeMs: GROUP_MINIMUM_LAYOUT_AGE_MS
            }
        });
    }

    public async write(
        transaction: PSqlSql,
        computed: GroupPresenceSummaryCoalescedWrite
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

    /**
     * Expands the reserved row together with every pending summary row of the
     * same group it can claim through the queue, so the group is read once and
     * its summary written once per tick; each claimed event still gets its own
     * delta row, in causal order.
     */
    public async processReservedEntry(
        message: ALMessage,
        entry: ResourceEntry
    ): Promise<ResourceInboxHandlerRetryableConflict | undefined> {
        const database = this.options.database;
        if (!database) {
            throw new TypeError('Presence-summary queue processing requires a database');
        }
        const primary = decodeCanonicalGroupPresenceSummaryWork(message, entry);
        const claimStartedAtMs = nowMs();
        const claimed = await this.claimPendingSummaryWork(entry);
        this.recordPhase({
            work: primary,
            operation: 'claim',
            details: { coalescedWorkCount: claimed.length + 1 },
            startedAtMs: claimStartedAtMs
        });
        try {
            const items = sortByCausalOrder([
                { work: primary, reservation: toReservationRead(entry) },
                ...claimed.map((sibling) => ({
                    work: decodeCanonicalGroupPresenceSummaryWork(decodePersistedALMessage(sibling.resource), sibling),
                    reservation: toReservationRead(sibling)
                }))
            ]);
            const written = await this.expandItems(database, primary, items);
            if (written === 'summary-changed') {
                await this.releaseClaimedWork(claimed);
                return new ResourceInboxHandlerRetryableConflict(
                    entry,
                    'group-presence-summary-changed',
                    new RuntimeStateWriteConflictError(),
                    GROUP_PRESENCE_SUMMARY_CONFLICT_RETRY_DELAY_MS
                );
            }
            return undefined;
        }
        catch (error) {
            await this.releaseClaimedWork(claimed);
            throw error;
        }
    }

    private async expandItems(
        database: PSqlSql,
        primary: GroupPresenceSummaryWorkData,
        items: readonly GroupPresenceSummaryWorkItem[]
    ): Promise<GroupPresenceSummaryWriteOutcome> {
        const workCount = { coalescedWorkCount: items.length };
        const read = await timeRallarAsync(
            this.options.timing,
            toGroupPresenceSummaryTimingEvent({
                work: primary,
                operation: 'read',
                serviceId: this.options.serviceId,
                details: workCount
            }),
            async () => await this.read(items, this.now())
        );
        const reads = read.fold(
            (inconsistency) => {
                throw new GroupPresenceSummaryReadInconsistencyError(inconsistency);
            },
            (value) => value
        );
        const computeStartedAtMs = nowMs();
        const expansions = items.map((item, index) => this.expand(item.work, reads[index]!));
        const coalesced = computeGroupPresenceSummaryCoalescedWrite(expansions.map((expansion) => expansion.computed));
        this.validateCoalesced(expansions, coalesced);
        const effectDetails = {
            ...workCount,
            recipientCount: toRecipientCount(expansions),
            deltaCount: coalesced.downstreamOutboxWrites.length
        };
        this.recordPhase({
            work: primary,
            operation: 'compute',
            details: effectDetails,
            startedAtMs: computeStartedAtMs
        });
        const proofs = expansions.flatMap((expansion) => computeGroupDeltaProvenance(expansion.computed));
        const outcome = await timeRallarAsync(
            this.options.timing,
            toGroupPresenceSummaryTimingEvent({
                work: primary,
                operation: 'write',
                serviceId: this.options.serviceId,
                details: effectDetails
            }),
            async () => await this.writeExpansion(database, coalesced, proofs)
        );
        if (outcome === 'written') {
            if (this.options.timing !== undefined) {
                recordGroupPresenceSummaryCommittedOutputs({
                    timing: this.options.timing,
                    serviceId: this.options.serviceId,
                    expansions
                });
            }
            this.options.wakeQueue?.();
            this.recordFormationMetrics(coalesced);
        }
        return outcome;
    }

    /** One transaction for the summary, its deltas, their proofs and every reservation finish; a lost summary write rolls all back. */
    private async writeExpansion(
        database: PSqlSql,
        coalesced: GroupPresenceSummaryCoalescedWrite,
        proofs: readonly GroupDeltaProvenanceInsert[]
    ): Promise<GroupPresenceSummaryWriteOutcome> {
        try {
            await runInPSqlTransaction(database, async (transaction) => {
                await this.write(transaction, coalesced);
                await writeGroupDeltaProvenance(transaction, proofs);
                for (const reservationFinish of coalesced.reservationFinishes) {
                    if (!await writeResourceInboxReservationFinish(transaction, reservationFinish)) {
                        throw new Error('Presence-summary reservation changed before commit');
                    }
                }
            });
            return 'written';
        }
        catch (error) {
            if (error instanceof GroupPresenceSummaryChangedError) {
                return 'summary-changed';
            }
            throw error;
        }
    }

    private expand(
        work: GroupPresenceSummaryWorkData,
        read: GroupPresenceSummaryWorkRead
    ): GroupPresenceSummaryExpansion {
        const computed = this.compute(work, read);
        const issue = this.validate(work, read, computed)[0];
        if (issue !== undefined) {
            throw issue.cause;
        }
        return { work, read, computed };
    }

    private validateCoalesced(
        expansions: readonly GroupPresenceSummaryExpansion[],
        coalesced: GroupPresenceSummaryCoalescedWrite
    ): void {
        const issue = validateGroupPresenceSummaryCoalescedWrite(
            expansions.map((expansion) => expansion.computed),
            coalesced
        )[0];
        if (issue !== undefined) {
            throw issue.cause;
        }
    }

    /** Claims, through the queue, the still-new summary rows of the same group; an unchanged observation is the claim's guard. */
    private async claimPendingSummaryWork(entry: ResourceEntry): Promise<readonly ResourceEntry[]> {
        const outbox = this.options.outboxQueueReader.outbox;
        const page = await outbox.readWorkPage({
            typeId: EnqueuedType.APP_OUTBOX,
            status: EntityStatus.NEW,
            maxToRead: COALESCED_SUMMARY_WORK_SCAN_LIMIT,
            cursor: null
        });
        const pending = page.entries.filter((candidate) => isPendingSummaryWorkOfSameGroup(candidate, entry));
        if (pending.length === 0) {
            return [];
        }
        const reserved = await outbox.reserveEntries({
            typeIds: new Set([EnqueuedType.APP_OUTBOX]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: pending.length,
            observedEntries: pending
        });
        return [...reserved.values()];
    }

    /** A claimed row that was not expanded consumed no attempt; it goes back to the queue at once. */
    private async releaseClaimedWork(claimed: readonly ResourceEntry[]): Promise<void> {
        if (claimed.length === 0) {
            return;
        }
        try {
            await this.options.outboxQueueReader.outbox.releaseEntries(
                claimed.map((entry) => ({
                    entry,
                    disposition: { status: EntityStatus.RETRY, delayMs: 1, reason: 'not-ready' }
                }))
            );
        }
        catch {
            // The expansion's own failure is the one to report; a claim this release could not return
            // is reclaimed by the queue's reservation timeout.
        }
    }

    private async readCoalescedTopologyEntry(ref: GroupRef): Promise<ResourceEntry | null> {
        const key = toAppQueueKey({
            topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
            resourceId: toRtcTopologyCoalescedGroupRevisionResourceId(toScopedOverlayId(ref)),
            contextId: groupStateGroupStorageKey(ref)
        });
        return (await this.options.outboxQueueReader.outbox.getItem(key)) ?? null;
    }

    private recordPhase(input: RecordGroupPresenceSummaryPhaseInput): void {
        const { work, operation, details, startedAtMs } = input;
        recordRallarTiming({
            sink: this.options.timing,
            event: toGroupPresenceSummaryTimingEvent({ work, operation, serviceId: this.options.serviceId, details }),
            status: 'ok',
            durationMs: nowMs() - startedAtMs
        });
    }

    private recordFormationMetrics(coalesced: GroupPresenceSummaryCoalescedWrite): void {
        try {
            this.options.formationMetrics?.({
                downstreamTopicIds: [
                    ...coalesced.downstreamOutboxWrites.map((write) => write.entry.key.topicId),
                    ...(coalesced.topologyReplan.decision === 'enqueue' ? [APP_OUTBOX_RTC_TOPOLOGY_TOPIC] : [])
                ]
            });
        }
        catch {
            // Metrics recording must not affect the committed queue work.
        }
    }
}

/** The queue boundary's form of an inconsistent read: a failed attempt the queue retries within its budget. */
class GroupPresenceSummaryReadInconsistencyError extends Error {
    readonly code: GroupPresenceSummaryReadInconsistency['code'];

    constructor(inconsistency: GroupPresenceSummaryReadInconsistency) {
        super(inconsistency.message);
        this.name = 'GroupPresenceSummaryReadInconsistencyError';
        this.code = inconsistency.code;
    }
}

/** The first item of a non-empty batch; every item must name its group. */
function requireSameGroup(items: readonly GroupPresenceSummaryWorkItem[]): GroupPresenceSummaryWorkItem {
    const first = items[0];
    if (first === undefined) {
        throw new TypeError('A presence summary read needs at least one work item');
    }
    const ref = first.work.aggregateRef;
    for (const item of items) {
        const candidate = item.work.aggregateRef;
        if (
            candidate.applicationId !== ref.applicationId ||
            candidate.workspaceId !== ref.workspaceId ||
            candidate.groupId !== ref.groupId
        ) {
            throw new TypeError('Coalesced presence summary work must belong to one group');
        }
    }
    return first;
}

/** Every expansion of one read shares the summary, so the first names the recipients of the batch. */
function toRecipientCount(expansions: readonly GroupPresenceSummaryExpansion[]): number {
    const expansion = expansions[0];
    if (expansion === undefined) {
        throw new TypeError('A presence summary expansion needs at least one item');
    }
    return expansion.computed.summary.summary.activeSessionIds.length;
}

function isPendingSummaryWorkOfSameGroup(candidate: ResourceEntry, entry: ResourceEntry): boolean {
    return candidate.key.topicId === entry.key.topicId &&
        candidate.key.contextId === entry.key.contextId &&
        !isKeysEqual(candidate.key, entry.key) &&
        isCanonicalGroupPresenceSummaryEntry(candidate);
}

function toReservationRead(entry: ResourceEntry): GroupPresenceSummaryReservationRead {
    return { key: entry.key, expectedAttempts: entry.dequeueAudit.attempts };
}

function sortByCausalOrder(
    items: readonly GroupPresenceSummaryWorkItem[]
): readonly GroupPresenceSummaryWorkItem[] {
    return [...items].sort((left, right) =>
        left.work.acceptedCausalRevision.groupRevision - right.work.acceptedCausalRevision.groupRevision ||
        left.work.acceptedCausalRevision.presenceRevision - right.work.acceptedCausalRevision.presenceRevision ||
        left.work.createdAtEpochMs - right.work.createdAtEpochMs ||
        left.work.commandId.localeCompare(right.work.commandId)
    );
}

async function writePresenceSummary(
    transaction: PSqlSql,
    computed: NonNullable<GroupPresenceSummaryCoalescedWrite['summaryWrite']>
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
        throw new GroupPresenceSummaryChangedError();
    }
}

/** Rolls the expansion's transaction back when its summary's compare-and-set loses; the handler answers a conflict. */
class GroupPresenceSummaryChangedError extends Error {
    constructor() {
        super('Presence summary changed before write');
        this.name = 'GroupPresenceSummaryChangedError';
    }
}
