import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
// prettier-ignore
import { fromCanonicalGroupTopologyConfigPatch }
  from '@shared/api/group-topology-config-canonical.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';

import type { PSqlSql, PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
// prettier-ignore
import { ResourceInboxRepository }
  from '../../../postgres/resource-inbox/ResourceInboxRepository.ts';
import { runInTransaction } from '../../../postgres/run-in-transaction.ts';
// prettier-ignore
import { RuntimeStateWriteConflictError }
  from '../../../runtime-state/optimistic-runtime-state-write.ts';
import {
  hashRtcTopologyExecutionCommand,
  type RtcTopologyPublication,
  toRtcTopologyPublicationId,
} from '../../repositories/RtcTopologyPublicationRepository.ts';
// prettier-ignore
import type { RtcTopologyExecutionRepository }
  from '../../repositories/RtcTopologyExecutionRepository.ts';
import { finishRtcTopologyReservation, finishRtcTopologyWork } from './finish-rtc-topology-work.ts';
import type { RtcTopologyDeliveryAppendPort } from './rtc-topology-delivery-append-port.ts';
import { RtcTopologyDeliveryLeaseLostError } from './rtc-topology-delivery-stream-service.ts';
import {
  isRtcTopologyDeliveryRetryableConflict,
  toRtcTopologyDeliveryAppendInput,
} from './rtc-topology-delivery-validation.ts';
import {
  materializeRtcOverlayTopologyBroadcastMessage,
  type RtcOverlayTopologyMessageFacts,
} from '../planning/materialize-rtc-overlay-topology-broadcast-message.ts';
import type { GroupTopologyPlanningService } from '../planning/group-topology-planning-service.ts';
import type { RallarTimingSink } from '../../services/timing.ts';
import {
  computeTopologyMutation,
  type RtcTopologyMutationComputed,
  validateTopologyMutation,
} from '../../services/rtc-topology-mutations.ts';
import { writeRtcTopologyPublicationOutbox } from '../../services/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyWorkRuntime } from '../../services/RtcTopologyOutboxWork.ts';
// prettier-ignore
import type { RtcRttRefinementService }
  from '../../rtc-topology/topic/rtc-rtt-refinement-service.ts';
import { isChangeGatedGroupRevisionWork } from './rtc-topology-coalesced-group-revision-work.ts';
import { computeAuthorityTopologyInputFingerprint } from './rtc-topology-input-fingerprint.ts';
import {
  type PersistedRtcTopologyWork,
  readRtcTopologyWorkEnvelope,
  toRtcTopologyExecutionId,
  type RtcTopologyWorkEnvelope,
} from './rtc-topology-work-codec.ts';

type AcceptedRtcTopologyMutation = Exclude<
  RtcTopologyMutationComputed,
  Readonly<{ outcome: 'loaded' | 'retry' }>
>;

// prettier-ignore
import {
  computeFormationCriterionCommand,
} from './compute-formation-criterion-command.ts';
// prettier-ignore
import type {
  GroupLifecyclePolicyRead,
} from '../../group-state/persistence/group-lifecycle-policy-repository.ts';
// prettier-ignore
import type {
  GroupMutationCommand,
} from '../../group-state/mutation/group-mutation-contracts.ts';
// prettier-ignore
import type {
  GroupTopologyPlanningAuthority,
} from '../planning/group-topology-planning-authority.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

export interface RtcTopologyDeliveryOptions {
  readonly publisherStreamId: string;
  readonly append: RtcTopologyDeliveryAppendPort;
}

interface RtcTopologyWorkHandlerOptions {
  readonly runtime: RtcTopologyWorkRuntime;
  readonly database: PSqlSql;
  readonly topologyPlanning: Pick<
    GroupTopologyPlanningService,
    | 'readTopologyPlanningAuthority'
    | 'computeTopologyFromAuthority'
    | 'observeCommittedTopology'
    | 'recordTopologyPublication'
    | 'recordTopologyRebuildSkippedFingerprint'
  >;
  readonly executionRepository: RtcTopologyExecutionRepository;
  readonly rttRefinementService?: RtcRttRefinementService;
  /**
   * The evidence leg of the activation criterion (plan slice 3b). Absent means
   * this deployment does not automate formation; groups then activate only by
   * operator command.
   */
  readonly formationCriterion?: Readonly<{
    readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
    submitCommand: (command: GroupMutationCommand, atEpochMs: number) => Promise<void>;
  }>;
  readonly topologyDelivery?: RtcTopologyDeliveryOptions;
  readonly onInactiveOverlay?: (overlayId: string) => void;
  readonly wakeQueue?: () => void;
  readonly wakeReplay?: () => void;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly timing?: RallarTimingSink;
  readonly serviceId?: string;
}

type AcceptedRtcTopologyWork =
  | Readonly<{
      decision: 'accepted';
      work: PersistedRtcTopologyWork;
      group: GroupSnapshot;
      computed: AcceptedRtcTopologyMutation;
      publication: RtcTopologyPublication | null;
      inputFingerprint: string;
    }>
  | Readonly<{
      decision: 'skipped-fingerprint';
      work: PersistedRtcTopologyWork;
      group: GroupSnapshot;
    }>
  | Readonly<{
      decision: 'skipped-unchanged';
      work: PersistedRtcTopologyWork;
      group: GroupSnapshot;
      inputFingerprint: string;
    }>
  | Readonly<{
      decision: 'skipped-rtt-refinement';
      work: PersistedRtcTopologyWork;
      group: GroupSnapshot;
    }>;

type RtcTopologyExecutionRead = Awaited<
  ReturnType<RtcTopologyExecutionRepository['readTopologyMutation']>
>;

interface ComputeAcceptedRtcTopologyWorkInput {
  readonly options: RtcTopologyWorkHandlerOptions;
  readonly workEnvelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>;
  readonly workId: string;
  readonly attemptCount: number;
  readonly read: RtcTopologyExecutionRead;
  readonly expireAtEpochMs: number;
}

interface ToTopologyPublicationInput {
  readonly envelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>;
  readonly group: GroupSnapshot;
  readonly snapshot: Parameters<typeof materializeRtcOverlayTopologyBroadcastMessage>[1];
  readonly facts: RtcOverlayTopologyMessageFacts;
}

export function createRtcTopologyWorkHandler(
  options: RtcTopologyWorkHandlerOptions,
): OnMessageCallback {
  return {
    onMessage: async (message, entry) => {
      await processRtcTopologyWork(options, message, entry);
    },
  };
}

async function processRtcTopologyWork(
  options: RtcTopologyWorkHandlerOptions,
  message: ALMessage,
  entry: ResourceEntry,
): Promise<void> {
  const workEnvelope = readRtcTopologyWorkEnvelope(message, options.runtime.workType);
  const workId = toRtcTopologyExecutionId(workEnvelope);
  const read = await options.executionRepository.readTopologyMutation(
    workEnvelope.data.groupSnapshot.group,
    workId,
  );
  if (read.publicationClaim) {
    await processLoadedRtcTopologyWork(options, entry, read);
    return;
  }
  const accepted = await computeAcceptedRtcTopologyWork({
    options,
    workEnvelope,
    workId,
    attemptCount: entry.dequeueAudit.attempts,
    read,
    expireAtEpochMs: entry.audit.expiryTs.epochMilliseconds,
  });
  await writeAcceptedRtcTopologyWork(options, entry, accepted);
}

async function processLoadedRtcTopologyWork(
  options: RtcTopologyWorkHandlerOptions,
  entry: ResourceEntry,
  read: Awaited<ReturnType<RtcTopologyExecutionRepository['readTopologyMutation']>>,
): Promise<void> {
  const replayInput = {
    read,
    candidate: null,
    publication: null,
    facts: {
      publicationExpireAtTimestamp: null,
      commandHash: null,
      attemptCount: null,
    },
  } as const;
  const computed = computeTopologyMutation(replayInput);
  validateTopologyMutation({ ...replayInput, computed });
  if (computed.outcome !== 'loaded') {
    throw new RuntimeStateWriteConflictError();
  }
  await writeRtcTopologyPublicationTransaction(options, entry, async (transaction) => {
    await writePublicationDelivery(transaction, computed.publication, options.topologyDelivery);
  });
  options.topologyPlanning.recordTopologyPublication(true);
  options.wakeQueue?.();
  options.wakeReplay?.();
}

async function petitionFormationCriterion(
  options: RtcTopologyWorkHandlerOptions,
  authority: GroupTopologyPlanningAuthority,
  planned: RallarOverlayTopologySnapshot,
): Promise<void> {
  if (!options.formationCriterion) return;
  const command = await computeFormationCriterionCommand({
    group: authority.group,
    planned,
    rttMeasurements: authority.rttMeasurements,
    nowEpochMs: authority.nowEpochMs,
    readLifecyclePolicy: options.formationCriterion.readLifecyclePolicy,
  });
  if (command === null) return;
  await options.formationCriterion.submitCommand(command, authority.nowEpochMs);
}

async function computeAcceptedRtcTopologyWork(
  input: ComputeAcceptedRtcTopologyWorkInput,
): Promise<AcceptedRtcTopologyWork> {
  const { options, workEnvelope, workId, attemptCount, read } = input;
  const work = workEnvelope.data;
  if (
    work.kind === 'rtt-refresh' &&
    options.rttRefinementService &&
    !options.rttRefinementService.claimWork({
      observationId: work.refinementObservationId,
      workId,
      groupKey: toWebRtcGroupKey(work.groupSnapshot.group),
      rtt: work.rtt,
      expireAtEpochMs: input.expireAtEpochMs,
    })
  ) {
    return {
      decision: 'skipped-rtt-refinement',
      work,
      group: work.groupSnapshot,
    };
  }
  const membershipDeltaWork = work.kind === 'group-revision';
  const authority = await options.topologyPlanning.readTopologyPlanningAuthority({
    groupRef: work.groupSnapshot.group,
    requestOptions: fromCanonicalGroupTopologyConfigPatch(work.requestOptions),
    knownGroup: work.groupSnapshot,
    snapshotSelection: membershipDeltaWork ? 'preserve-known-revision' : 'prefer-current',
  });
  const inputFingerprint = await computeAuthorityTopologyInputFingerprint(authority);
  const changeGated = work.kind === 'group-revision' && isChangeGatedGroupRevisionWork(work);
  if (changeGated && read.snapshot?.value.state === 'active') {
    const storedFingerprint = await options.executionRepository.readTopologyInputFingerprint(
      authority.group.group,
    );
    if (storedFingerprint === inputFingerprint) {
      return { decision: 'skipped-fingerprint', work, group: authority.group };
    }
  }
  const computedTopology = options.topologyPlanning.computeTopologyFromAuthority(
    authority,
    read.snapshot?.value,
    membershipDeltaWork ? 'membership-delta' : 'full-rebuild',
  );
  await petitionFormationCriterion(options, authority, computedTopology.snapshot);
  // RTT is deliberately outside the fingerprint, so an RTT refresh always
  // replans — but an unchanged planned graph publishes nothing (M8).
  const unchangedGated = changeGated || work.kind !== 'group-revision';
  if (unchangedGated && read.snapshot !== null && !computedTopology.changed) {
    return { decision: 'skipped-unchanged', work, group: authority.group, inputFingerprint };
  }
  const publicationExpireAtTimestamp = work.publish
    ? options.executionRepository.publicationExpireAtTimestamp()
    : null;
  const publication =
    publicationExpireAtTimestamp === null
      ? null
      : toTopologyPublication({
          envelope: workEnvelope,
          group: authority.group,
          snapshot: computedTopology.snapshot,
          facts: {
            workId,
            createdAtEpochMs: work.requestedAtEpochMs,
            expiresAtEpochMs: publicationExpireAtTimestamp,
          },
        });
  const facts =
    publication && publicationExpireAtTimestamp !== null
      ? {
          publicationExpireAtTimestamp,
          commandHash: await hashRtcTopologyExecutionCommand(publication),
          attemptCount,
        }
      : ({
          publicationExpireAtTimestamp: null,
          commandHash: null,
          attemptCount: null,
        } as const);
  const computed = computeTopologyMutation({
    read,
    candidate: computedTopology.snapshot,
    publication,
    facts,
  });
  validateTopologyMutation({
    read,
    candidate: computedTopology.snapshot,
    publication,
    facts,
    computed,
  });
  if (computed.outcome === 'retry') {
    throw new RuntimeStateWriteConflictError();
  }
  if (computed.outcome === 'loaded') {
    throw new TypeError('RTC topology publication claim appeared on a claim-miss path');
  }
  return {
    decision: 'accepted',
    work,
    group: authority.group,
    computed,
    publication,
    inputFingerprint,
  };
}

async function writeAcceptedRtcTopologyWork(
  options: RtcTopologyWorkHandlerOptions,
  entry: ResourceEntry,
  accepted: AcceptedRtcTopologyWork,
): Promise<void> {
  if (accepted.decision === 'skipped-rtt-refinement') {
    await finishRtcTopologyWork(options.database, entry);
    return;
  }
  if (accepted.decision === 'skipped-fingerprint') {
    await finishRtcTopologyWork(options.database, entry);
    options.topologyPlanning.recordTopologyRebuildSkippedFingerprint();
    return;
  }
  if (accepted.decision === 'skipped-unchanged') {
    await runInTransaction(options.database, async (transaction) => {
      await options.executionRepository.writeTopologyInputFingerprint(
        transaction,
        accepted.group.group,
        accepted.inputFingerprint,
      );
      await finishRtcTopologyReservation(transaction, entry);
    });
    options.topologyPlanning.recordTopologyPublication(false);
    return;
  }
  const computed = accepted.computed;
  if (computed.outcome === 'superseded') {
    await finishRtcTopologyWork(options.database, entry);
    options.topologyPlanning.observeCommittedTopology(accepted.group, computed.current);
    return;
  }
  await writeRtcTopologyPublicationTransaction(options, entry, async (transaction) => {
    await options.executionRepository.writeTopologyMutation(transaction, computed);
    if (computed.outcome === 'write') {
      await options.executionRepository.writeTopologyInputFingerprint(
        transaction,
        accepted.group.group,
        accepted.inputFingerprint,
      );
    }
    if (accepted.publication) {
      await writePublicationDelivery(transaction, accepted.publication, options.topologyDelivery);
    }
  });
  const committedSnapshot =
    computed.outcome === 'write' ? computed.snapshotGuard.candidate : computed.currentGuard.current;
  options.topologyPlanning.observeCommittedTopology(accepted.group, committedSnapshot);
  if (committedSnapshot.state === 'removed') {
    options.onInactiveOverlay?.(accepted.work.overlayId);
  }
  if (accepted.publication) {
    options.topologyPlanning.recordTopologyPublication(true);
    options.wakeQueue?.();
    options.wakeReplay?.();
  }
}

async function writeRtcTopologyPublicationTransaction(
  options: Pick<RtcTopologyWorkHandlerOptions, 'database'>,
  entry: ResourceEntry,
  write: (transaction: PSqlTransactionSql) => Promise<void>,
): Promise<void> {
  try {
    await runInTransaction(options.database, async (transaction) => {
      await write(transaction);
      await finishRtcTopologyReservation(transaction, entry);
    });
  } catch (error) {
    if (error instanceof Error && isRtcTopologyDeliveryRetryableConflict(error)) {
      throw new RuntimeStateWriteConflictError();
    }
    throw error;
  }
}

async function writePublicationDelivery(
  transaction: PSqlTransactionSql,
  publication: RtcTopologyPublication,
  delivery: RtcTopologyDeliveryOptions | undefined,
): Promise<void> {
  const outbox = await writeRtcTopologyPublicationOutbox(transaction, publication);
  if (!delivery) {
    return;
  }
  const result = await delivery.append.appendOrValidate(
    transaction,
    toRtcTopologyDeliveryAppendInput(delivery.publisherStreamId, publication, outbox),
  );
  if (result.status === 'conflict') {
    throw new RuntimeStateWriteConflictError();
  }
  if (result.status === 'lease-lost') {
    throw new RtcTopologyDeliveryLeaseLostError(
      `RTC topology publisher stream ${delivery.publisherStreamId} lost its lease`,
    );
  }
}

function toTopologyPublication(input: ToTopologyPublicationInput): RtcTopologyPublication {
  const { envelope, group, snapshot, facts } = input;
  const workId = toRtcTopologyExecutionId(envelope);
  return {
    publicationId: toRtcTopologyPublicationId({
      workId,
      sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
      overlayVersion: snapshot.version,
    }),
    workId,
    groupRef: canonicalGroupRef(group.group),
    sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
    overlayVersion: snapshot.version,
    targetGroupSnapshotVersion: group.group.snapshotVersion,
    recipientSessionIds: snapshot.activeSessionIds,
    message: materializeRtcOverlayTopologyBroadcastMessage(group, snapshot, facts),
    createdAtEpochMs: facts.createdAtEpochMs,
  };
}

function canonicalGroupRef(ref: GroupRef): GroupRef {
  return {
    applicationId: ref.applicationId,
    workspaceId: ref.workspaceId,
    groupId: ref.groupId,
  };
}
