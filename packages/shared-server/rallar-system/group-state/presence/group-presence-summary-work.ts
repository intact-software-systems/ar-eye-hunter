import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type {
  GroupEvent,
  GroupMember,
  GroupPresenceSession,
  GroupRef,
  GroupSnapshot,
  GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
// prettier-ignore
import type {
  GroupPresenceSummaryWorkData,
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
// prettier-ignore
import {
  toCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { requireConditionalWrite } from '../../../runtime-state/optimistic-runtime-state-write.ts';
// prettier-ignore
import type {
  RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
import type { PSqlSql, PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import { runInTransaction } from '../../../postgres/run-in-transaction.ts';
// prettier-ignore
import {
  ResourceInboxRepository,
} from '../../../postgres/resource-inbox/ResourceInboxRepository.ts';
import {
  createTransactionBoundGroupStateRepository,
  GroupStateRepository,
} from '../persistence/group-state-repository.ts';
import { assembleGroupStateSnapshot } from '../persistence/assemble-group-state-snapshot.ts';
import {
  computeGroupPresenceSummary,
  type GroupPresenceSummaryComputed,
  type GroupPresenceSummaryRead,
  validateGroupPresenceSummary,
} from './compute-group-presence-summary.ts';
import {
  computeGroupStateSyncEntries,
  type ComputedGroupStateSyncEffect,
  type StateSyncAudience,
} from '../../state-sync-publisher.ts';
import { computeRtcTopologyEntry } from '../../services/RtcTopologyOutboxWork.ts';
import {
  CoalescedAppOutboxWorkService,
  type ComputedCoalescedAppOutboxWork,
} from '../../services/CoalescedAppOutboxWorkService.ts';
// prettier-ignore
import {
  computeCoalescedRtcTopologyGroupRevisionWork,
  toRtcTopologyCoalescedGroupRevisionResourceId,
} from '../../topology/replay/rtc-topology-coalesced-group-revision-work.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '../../services/rtc-topology-outbox-entry.ts';
import { toAppQueueKey } from '../../services/app-inbox-queue-key.ts';
import { groupStateGroupStorageKey } from '../persistence/group-state-storage-keys.ts';
// prettier-ignore
import type {
  GroupFormationPresenceSummarySink,
} from '../../formation-metrics.ts';
// prettier-ignore
import {
  decodeCanonicalGroupPresenceSummaryWork,
} from './decode-canonical-group-presence-summary-work.ts';

export type GroupPresenceSummaryTopologyIntent =
  | Readonly<{
      damping: 'damped';
      outboxQueueReader: OutboxQueueReader;
      recomputeDebounceMs: number;
    }>
  | Readonly<{ damping: 'legacy' }>;

export type GroupStateDisseminationMode = 'snapshot-per-change' | 'dual-emit' | 'delta-primary';

export type GroupPresenceSummaryWorkOptions = Readonly<{
  runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
  topologyIntent: GroupPresenceSummaryTopologyIntent;
  disseminationMode: GroupStateDisseminationMode;
  database?: PSqlSql;
  now?: () => number;
  serviceId: string;
  wakeQueue?: () => void;
  timing?: import('../../services/timing.ts').RallarTimingSink;
  formationMetrics?: GroupFormationPresenceSummarySink;
}>;

export type GroupPresenceSummaryWorkRead = Readonly<{
  presence: GroupPresenceSummaryRead;
  coalescedTopologyEntry: ResourceEntry | null;
}>;

export type GroupPresenceSummaryComputedWork = Readonly<{
  work: GroupPresenceSummaryWorkData;
  summary: GroupPresenceSummaryComputed;
  snapshot: GroupSnapshot;
  downstreamOutboxEntries: readonly ResourceEntry[];
  coalescedTopologyWork: ComputedCoalescedAppOutboxWork | null;
}>;

export interface ComputeGroupPresenceSummaryOutboxInput {
  readonly work: GroupPresenceSummaryWorkData;
  readonly summary: GroupPresenceSummaryComputed;
  readonly summaryPredecessorCausalRevision: GroupStateCausalRevision | null;
  readonly snapshot: GroupSnapshot;
  readonly audience: StateSyncAudience;
  readonly serviceId: string;
  readonly disseminationMode: GroupStateDisseminationMode;
  readonly includePerCommandTopologyEntry: boolean;
}

export interface ComputeGroupStateDeltaEnvelopeInput {
  readonly event: GroupEvent;
  readonly summary: GroupPresenceSummaryComputed;
  readonly summaryPredecessorCausalRevision: GroupStateCausalRevision | null;
  readonly snapshot: GroupSnapshot;
}

export class GroupPresenceSummaryWork {
  private readonly now: () => number;
  private readonly coalescedTopologyWorkService: CoalescedAppOutboxWorkService | null;

  private readonly options: GroupPresenceSummaryWorkOptions;

  constructor(options: GroupPresenceSummaryWorkOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.coalescedTopologyWorkService =
      options.topologyIntent.damping === 'damped'
        ? new CoalescedAppOutboxWorkService(
            options.topologyIntent.outboxQueueReader,
            options.serviceId,
            this.now,
          )
        : null;
  }

  async read(work: GroupPresenceSummaryWorkData): Promise<GroupPresenceSummaryWorkRead> {
    const repository = new GroupStateRepository(this.options.runtimeRepository);
    const [group, members, admissions, presenceSessions, current, coalescedTopologyEntry] =
      await Promise.all([
        repository.findGroupEntry(work.aggregateRef),
        repository.listMemberEntries(work.aggregateRef),
        repository.listPresenceAdmissionEntries(work.aggregateRef),
        repository.listPresenceSessionEntries(work.aggregateRef),
        repository.findPresenceSummaryEntry(work.aggregateRef),
        this.readCoalescedTopologyEntry(work.aggregateRef),
      ]);
    if (!group) {
      throw new TypeError(`Group not found for presence summary: ${work.aggregateRef.groupId}`);
    }
    return {
      presence: {
        group,
        members,
        admissions,
        presenceSessions,
        current: current ?? null,
      },
      coalescedTopologyEntry,
    };
  }

  private async readCoalescedTopologyEntry(ref: GroupRef): Promise<ResourceEntry | null> {
    const intent = this.options.topologyIntent;
    if (intent.damping !== 'damped') return null;
    const key = toAppQueueKey({
      topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
      resourceId: toRtcTopologyCoalescedGroupRevisionResourceId(toScopedOverlayId(ref)),
      contextId: groupStateGroupStorageKey(ref),
    });
    return (await intent.outboxQueueReader.outbox.getItem(key)) ?? null;
  }

  compute(
    work: GroupPresenceSummaryWorkData,
    read: GroupPresenceSummaryWorkRead,
  ): GroupPresenceSummaryComputedWork {
    const summary = computeGroupPresenceSummary({
      ref: work.aggregateRef,
      read: read.presence,
      nowEpochMs: this.now(),
      formationDamping: this.options.topologyIntent.damping,
    });
    const snapshot = assembleGroupStateSnapshot(
      {
        group: read.presence.group.value,
        members: read.presence.members.map((member) => member.value),
        summary: summary.summary,
        authoritativeSessions: read.presence.presenceSessions.map((session) => session.value),
        groupRevision: summary.summary.causalRevision.groupRevision,
        observedAtEpochMs: summary.summary.computedAtEpochMs,
        sessionLeaseFields:
          this.options.topologyIntent.damping === 'damped' ? 'authoritative' : 'summary-frozen',
      },
      (storageKey, message) => new Error(`${message}: ${storageKey}`),
    );
    const intent = this.options.topologyIntent;
    return {
      work,
      summary,
      snapshot,
      downstreamOutboxEntries: computeGroupPresenceSummaryOutboxEntries(
        this.toGroupPresenceSummaryOutboxInput(work, read, { summary, snapshot }),
      ),
      coalescedTopologyWork:
        intent.damping === 'damped'
          ? computeCoalescedRtcTopologyGroupRevisionWork({
              aggregateRef: work.aggregateRef,
              groupSnapshot: snapshot,
              requestedAtEpochMs: summary.summary.computedAtEpochMs,
              expireAtEpochMs: work.expireAtEpochMs,
              recomputeDebounceMs: intent.recomputeDebounceMs,
              senderId: this.options.serviceId,
              previousEntry: read.coalescedTopologyEntry,
            })
          : null,
    };
  }

  validate(
    work: GroupPresenceSummaryWorkData,
    read: GroupPresenceSummaryWorkRead,
    computed: GroupPresenceSummaryComputedWork,
  ): void {
    if (computed.work !== work) {
      throw new TypeError('Presence-summary computed work differs from its command');
    }
    validateGroupPresenceSummary({
      ref: work.aggregateRef,
      read: read.presence,
      computed: computed.summary,
      formationDamping: this.options.topologyIntent.damping,
    });
    if (
      work.event.applicationId !== work.aggregateRef.applicationId ||
      work.event.workspaceId !== work.aggregateRef.workspaceId ||
      work.event.groupId !== work.aggregateRef.groupId ||
      work.event.causalRevision.groupRevision !== work.acceptedCausalRevision.groupRevision ||
      work.event.causalRevision.presenceRevision !== work.acceptedCausalRevision.presenceRevision
    ) {
      throw new TypeError('Presence-summary event differs from accepted group revision');
    }
    validateGroupPresenceSummaryOutboxEntries(
      computed.downstreamOutboxEntries,
      this.toGroupPresenceSummaryOutboxInput(work, read, computed),
    );
  }

  private toGroupPresenceSummaryOutboxInput(
    work: GroupPresenceSummaryWorkData,
    read: GroupPresenceSummaryWorkRead,
    computed: Readonly<{ summary: GroupPresenceSummaryComputed; snapshot: GroupSnapshot }>,
  ): ComputeGroupPresenceSummaryOutboxInput {
    return {
      work,
      summary: computed.summary,
      summaryPredecessorCausalRevision: read.presence.current?.value.causalRevision ?? null,
      snapshot: computed.snapshot,
      audience: {
        kind: 'group',
        applicationId: work.aggregateRef.applicationId,
        workspaceId: work.aggregateRef.workspaceId,
        resourceId: work.aggregateRef.groupId,
      },
      serviceId: this.options.serviceId,
      disseminationMode: this.options.disseminationMode,
      includePerCommandTopologyEntry: this.options.topologyIntent.damping === 'legacy',
    };
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
    if (computed.coalescedTopologyWork !== null) {
      if (this.coalescedTopologyWorkService === null) {
        throw new TypeError('Coalesced topology work requires the damped topology intent');
      }
      await this.coalescedTopologyWorkService.write(transaction, computed.coalescedTopologyWork);
    }
  }

  async processReservedEntry(message: ALMessage, entry: ResourceEntry): Promise<void> {
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
    try {
      this.options.formationMetrics?.({
        downstreamTopicIds: [
          ...computed.downstreamOutboxEntries.map((outboxEntry) => outboxEntry.key.topicId),
          ...(computed.coalescedTopologyWork !== null ? [APP_OUTBOX_RTC_TOPOLOGY_TOPIC] : []),
        ],
      });
    } catch {
      // Recording must never affect presence-summary behavior.
    }
  }
}

export function computeGroupPresenceSummaryOutboxEntries(
  input: ComputeGroupPresenceSummaryOutboxInput,
): readonly ResourceEntry[] {
  const { work, audience, serviceId } = input;
  const eventEntries = computeGroupStateSyncEntries(
    {
      commandId: work.commandId,
      aggregateRef: work.aggregateRef,
      acceptedCausalRevision: work.acceptedCausalRevision,
      audience,
      createdAtEpochMs: work.createdAtEpochMs,
      expireAtEpochMs: work.expireAtEpochMs,
      effects: [computeGroupStateEventEffect(input)],
    },
    serviceId,
  );
  const snapshotEntries =
    input.disseminationMode === 'delta-primary' ? [] : computeGroupSnapshotSyncEntries(input);
  if (!input.includePerCommandTopologyEntry) {
    return [...eventEntries, ...snapshotEntries];
  }
  const topologyEntry = computeGroupPresenceTopologyOutboxEntry(input);
  return [...eventEntries, ...snapshotEntries, topologyEntry];
}

function computeGroupSnapshotSyncEntries(
  input: ComputeGroupPresenceSummaryOutboxInput,
): readonly ResourceEntry[] {
  const { work, summary, snapshot, audience, serviceId } = input;
  return computeGroupStateSyncEntries(
    {
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
    },
    serviceId,
  );
}

/**
 * Deterministic recomputation mirror for the presence-summary expansion's
 * downstream WS rows: the computed entry set must be byte-identical to the
 * canonical projection for the active dissemination mode.
 */
export function validateGroupPresenceSummaryOutboxEntries(
  computedEntries: readonly ResourceEntry[],
  input: ComputeGroupPresenceSummaryOutboxInput,
): void {
  if (!jsonEquals(computedEntries, computeGroupPresenceSummaryOutboxEntries(input))) {
    throw new TypeError('Presence-summary downstream outbox entries are not canonical');
  }
}

function computeGroupStateEventEffect(
  input: ComputeGroupPresenceSummaryOutboxInput,
): ComputedGroupStateSyncEffect {
  if (input.disseminationMode === 'snapshot-per-change') {
    return {
      effectKind: 'member-state',
      payloadKind: 'event',
      payload: input.work.event,
    };
  }
  return {
    effectKind: 'member-state',
    payloadKind: 'delta-envelope',
    payload: computeGroupStateDeltaEnvelope({
      event: input.work.event,
      summary: input.summary,
      summaryPredecessorCausalRevision: input.summaryPredecessorCausalRevision,
      snapshot: input.snapshot,
    }),
  };
}

export function computeGroupStateDeltaEnvelope(
  input: ComputeGroupStateDeltaEnvelopeInput,
): GroupStateDeltaEnvelope {
  const { event, snapshot } = input;
  const activeSessionIds = snapshot.activeSessions.map((session) => session.sessionId);
  const removedSessionIds =
    event.eventType === 'session-disconnected' &&
    event.actor.kind === 'session' &&
    !activeSessionIds.includes(event.actor.sessionId)
      ? [event.actor.sessionId]
      : [];
  return {
    event,
    predecessorCausalRevision: resolveGroupStateDeltaPredecessorCausalRevision(input),
    resultingCausalRevision: snapshot.causalRevision,
    members: snapshot.members.filter((member) => isGroupMemberWrittenByEvent(member, event)),
    removedMemberPrincipalIds: [],
    sessions: computeGroupStateDeltaSessions(event, snapshot),
    removedSessionIds,
    activeSessionIds,
    group: snapshot.group,
    memberCount: snapshot.memberCount,
    onlineMemberCount: snapshot.onlineMemberCount,
    audienceSessionIds: input.summary.summary.activeSessionIds,
  };
}

/**
 * A summary no-op expansion has no CAS predecessor, so it stamps
 * predecessor === resulting. A summary insert has no stored predecessor
 * either; presenceRevision - 1 (= 0) matches the snapshot revision a REST
 * read assembles before any summary exists for the group.
 */
function resolveGroupStateDeltaPredecessorCausalRevision(
  input: ComputeGroupStateDeltaEnvelopeInput,
): GroupStateCausalRevision {
  const resulting = input.snapshot.causalRevision;
  if (input.summary.outcome === 'no-op') return resulting;
  if (input.summaryPredecessorCausalRevision !== null) {
    return input.summaryPredecessorCausalRevision;
  }
  return {
    groupRevision: resulting.groupRevision,
    presenceRevision: resulting.presenceRevision - 1,
  };
}

/**
 * Member records written by the event's command carry the command's audit
 * time and request id. The audit actor may differ from the event actor
 * through creation/join fallback identity, so it must not join the match.
 */
function isGroupMemberWrittenByEvent(member: GroupMember, event: GroupEvent): boolean {
  return (
    member.updated.atEpochMs === event.occurredAtEpochMs &&
    member.updated.requestId === event.requestId
  );
}

/**
 * The durable event carries no target-session identity, so the affected
 * slice for a session-lifecycle event is the acting principal's resulting
 * sessions. Service-driven transitions (expiry disconnects) carry no
 * session slice; browsers reconcile them from the complete identity set.
 */
function computeGroupStateDeltaSessions(
  event: GroupEvent,
  snapshot: GroupSnapshot,
): readonly GroupPresenceSession[] {
  if (
    event.eventType !== 'session-connected' &&
    event.eventType !== 'session-heartbeat' &&
    event.eventType !== 'session-disconnected'
  ) {
    return [];
  }
  const actor = event.actor;
  if (actor.kind === 'service') return [];
  return snapshot.activeSessions.filter((session) => session.principalId === actor.principalId);
}

function computeGroupPresenceTopologyOutboxEntry(
  input: ComputeGroupPresenceSummaryOutboxInput,
): ResourceEntry {
  const { work, summary, snapshot, serviceId } = input;
  return computeRtcTopologyEntry(
    {
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
    },
    serviceId,
  );
}

export function toGroupPresenceSummaryQueueContextId(ref: GroupRef): string {
  return JSON.stringify([ref.applicationId, ref.workspaceId, ref.groupId]);
}
