import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
  fromCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';

import type {
  PSqlSql,
  PSqlTransactionSql,
} from '../../../postgres/PostgresSqlClient.ts';
import {
  ResourceInboxRepository,
} from '../../../postgres/resource-inbox/ResourceInboxRepository.ts';
import { runInTransaction } from '../../../postgres/run-in-transaction.ts';
import {
  RuntimeStateWriteConflictError,
} from '../../../runtime-state/optimistic-runtime-state-write.ts';
import {
  hashRtcTopologyExecutionCommand,
  type RtcTopologyPublication,
  toRtcTopologyPublicationId,
} from '../../repositories/RtcTopologyPublicationRepository.ts';
import type {
  RtcTopologyExecutionRepository,
} from '../../repositories/RtcTopologyExecutionRepository.ts';
import type { RtcTopologyDeliveryAppendPort } from './rtc-topology-delivery-append-port.ts';
import { RtcTopologyDeliveryLeaseLostError } from './rtc-topology-delivery-stream-service.ts';
import {
  isRtcTopologyDeliveryRetryableConflict,
  toRtcTopologyDeliveryAppendInput,
} from './rtc-topology-delivery-validation.ts';
import {
  type GroupTopologyManagementService,
  materializeRtcOverlayTopologyBroadcastMessage,
  type RtcOverlayTopologyMessageFacts,
} from '../../services/group-topology-management-service.ts';
import type { RallarTimingSink } from '../../services/timing.ts';
import {
  computeTopologyMutation,
  type RtcTopologyMutationComputed,
  validateTopologyMutation,
} from '../../services/rtc-topology-mutations.ts';
import { writeRtcTopologyPublicationOutbox } from '../../services/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyWorkRuntime } from '../../services/RtcTopologyOutboxWork.ts';
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

export interface RtcTopologyDeliveryOptions {
  readonly publisherStreamId: string;
  readonly append: RtcTopologyDeliveryAppendPort;
}

interface RtcTopologyWorkHandlerOptions {
  readonly runtime: RtcTopologyWorkRuntime;
  readonly database: PSqlSql;
  readonly topologyManagement: GroupTopologyManagementService;
  readonly executionRepository: RtcTopologyExecutionRepository;
  readonly topologyDelivery?: RtcTopologyDeliveryOptions;
  readonly onInactiveOverlay?: (overlayId: string) => void;
  readonly wakeQueue?: () => void;
  readonly wakeReplay?: () => void;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly timing?: RallarTimingSink;
  readonly serviceId?: string;
}

interface AcceptedRtcTopologyWork {
  readonly work: PersistedRtcTopologyWork;
  readonly group: GroupSnapshot;
  readonly computed: AcceptedRtcTopologyMutation;
  readonly publication: RtcTopologyPublication | null;
}

type RtcTopologyExecutionRead = Awaited<
  ReturnType<RtcTopologyExecutionRepository['readTopologyMutation']>
>;

interface ComputeAcceptedRtcTopologyWorkInput {
  readonly options: RtcTopologyWorkHandlerOptions;
  readonly workEnvelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>;
  readonly workId: string;
  readonly attemptCount: number;
  readonly read: RtcTopologyExecutionRead;
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
  options.topologyManagement.recordTopologyPublication(true);
  options.wakeQueue?.();
  options.wakeReplay?.();
}

async function computeAcceptedRtcTopologyWork(
  input: ComputeAcceptedRtcTopologyWorkInput,
): Promise<AcceptedRtcTopologyWork> {
  const { options, workEnvelope, workId, attemptCount, read } = input;
  const work = workEnvelope.data;
  const authority = await options.topologyManagement.readTopologyPlanningAuthority(
    work.groupSnapshot.group,
    fromCanonicalGroupTopologyConfigPatch(work.requestOptions),
    work.groupSnapshot,
    work.kind === 'group-revision',
  );
  const computedTopology = options.topologyManagement.computeTopologyFromAuthority(
    authority,
    read.snapshot?.value,
  );
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
  return { work, group: authority.group, computed, publication };
}

async function writeAcceptedRtcTopologyWork(
  options: RtcTopologyWorkHandlerOptions,
  entry: ResourceEntry,
  accepted: AcceptedRtcTopologyWork,
): Promise<void> {
  const computed = accepted.computed;
  if (computed.outcome === 'superseded') {
    await finishRtcTopologyWork(options.database, entry);
    options.topologyManagement.observeCommittedTopology(accepted.group, computed.current);
    return;
  }
  await writeRtcTopologyPublicationTransaction(options, entry, async (transaction) => {
    await options.executionRepository.writeTopologyMutation(transaction, computed);
    if (accepted.publication) {
      await writePublicationDelivery(transaction, accepted.publication, options.topologyDelivery);
    }
  });
  const committedSnapshot =
    computed.outcome === 'write' ? computed.snapshotGuard.candidate : computed.currentGuard.current;
  options.topologyManagement.observeCommittedTopology(accepted.group, committedSnapshot);
  if (committedSnapshot.state === 'removed') {
    options.onInactiveOverlay?.(accepted.work.overlayId);
  }
  if (accepted.publication) {
    options.topologyManagement.recordTopologyPublication(true);
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

async function finishRtcTopologyWork(database: PSqlSql, entry: ResourceEntry): Promise<void> {
  await runInTransaction(database, async (transaction) => {
    await finishRtcTopologyReservation(transaction, entry);
  });
}

async function finishRtcTopologyReservation(
  transaction: PSqlTransactionSql,
  entry: ResourceEntry,
): Promise<void> {
  const finished = await new ResourceInboxRepository(transaction).finishReserved(
    entry.key,
    entry.dequeueAudit.attempts,
    EntityStatus.COMPLETED,
    new Date(),
  );
  if (!finished) {
    throw new RuntimeStateWriteConflictError();
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
