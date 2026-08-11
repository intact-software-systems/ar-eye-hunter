import { Temporal } from '@js-temporal/polyfill';

import { EnqueuedType } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { readGroupCausalRevision, readGroupStateRevision } from '@shared/api/group-client-views.ts';
import {
  isPreserveOnlyCanonicalGroupTopologyConfigPatch,
  toCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { groupStateGroupStorageKey } from '../../group-state-storage-keys.ts';
import { AppOutboxType } from '../../services/AppOutboxService.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '../../services/app-inbox-queue-key.ts';
import {
  COALESCED_APP_OUTBOX_WORK_FIELD,
  type CoalescedAppOutboxWorkData,
  type CoalescedAppOutboxWorkEnvelope,
  type ComputedCoalescedAppOutboxWork,
  isMutableCoalescedStatus,
  tryReadCoalescedAppOutboxWorkEnvelope,
} from '../../services/CoalescedAppOutboxWorkService.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '../../services/rtc-topology-outbox-entry.ts';
import type { RtcTopologyGroupRevisionWork } from '../../services/RtcTopologyOutboxWork.ts';
import type { PersistedRtcTopologyWork } from './rtc-topology-work-codec.ts';

export const DEFAULT_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS = 500;

export interface RtcTopologyCoalescedGroupRevisionInput {
  readonly aggregateRef: GroupRef;
  readonly groupSnapshot: GroupSnapshot;
  readonly requestedAtEpochMs: number;
  readonly expireAtEpochMs: number;
  readonly recomputeDebounceMs: number;
  readonly senderId: string;
  readonly previousEntry: ResourceEntry | null;
}

export function toRtcTopologyCoalescedGroupRevisionResourceId(overlayId: string): string {
  return `${overlayId}:group-revision`;
}

export function computeCoalescedRtcTopologyGroupRevisionWork(
  input: RtcTopologyCoalescedGroupRevisionInput,
): ComputedCoalescedAppOutboxWork {
  validateCoalescedGroupRevisionInput(input);
  const overlayId = toScopedOverlayId(input.aggregateRef);
  const incoming: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> = {
    kind: 'group-revision',
    overlayId,
    groupSnapshot: input.groupSnapshot,
    sourceGroupStateRevision: readGroupStateRevision(input.groupSnapshot),
    requestedAtEpochMs: input.requestedAtEpochMs,
    requestOptions: toCanonicalGroupTopologyConfigPatch({}),
    publish: true,
    [COALESCED_APP_OUTBOX_WORK_FIELD]: {
      generation: 1,
      requestedAtEpochMs: input.requestedAtEpochMs,
      dueAtEpochMs: input.requestedAtEpochMs + input.recomputeDebounceMs,
      reasons: ['group-revision'],
    },
  };
  const successorEntry = toCoalescedGroupRevisionEntry({
    input,
    resourceId: toRtcTopologyCoalescedGroupRevisionSuccessorResourceId(
      overlayId,
      incoming.sourceGroupStateRevision,
    ),
    data: incoming,
    dequeueAudit: { attempts: 0 },
    entryAudit: null,
    messageIdentity: null,
  });
  if (input.previousEntry === null) {
    return {
      expectedEntry: null,
      entry: toCoalescedGroupRevisionEntry({
        input,
        resourceId: toRtcTopologyCoalescedGroupRevisionResourceId(overlayId),
        data: incoming,
        dequeueAudit: { attempts: 0 },
        entryAudit: null,
        messageIdentity: null,
      }),
      successorEntry,
    };
  }
  const previous = readPreviousCoalescedGroupRevisionEnvelope(input.previousEntry);
  const previousGeneration = previous.data[COALESCED_APP_OUTBOX_WORK_FIELD].generation;
  const merged = isMutableCoalescedStatus(input.previousEntry.status)
    ? mergeRtcTopologyGroupRevisionWork(previous.data, incoming)
    : incoming;
  const nextData: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> = {
    ...merged,
    [COALESCED_APP_OUTBOX_WORK_FIELD]: {
      ...merged[COALESCED_APP_OUTBOX_WORK_FIELD],
      generation: previousGeneration + 1,
      requestedAtEpochMs: input.requestedAtEpochMs,
    },
  };
  const carriesPreviousLifecycle = isMutableCoalescedStatus(input.previousEntry.status);
  return {
    expectedEntry: input.previousEntry,
    entry: toCoalescedGroupRevisionEntry({
      input,
      resourceId: toRtcTopologyCoalescedGroupRevisionResourceId(overlayId),
      data: nextData,
      dequeueAudit: {
        attempts: carriesPreviousLifecycle ? input.previousEntry.dequeueAudit.attempts : 0,
      },
      entryAudit: input.previousEntry.audit,
      messageIdentity: readPreviousMessageIdentity(input.previousEntry),
    }),
    successorEntry,
  };
}

/**
 * A stored coalesced row never rewrites its created-audit columns — both the
 * pending merge and the terminal revival compare-and-set update the resource
 * and lifecycle only. Every later generation must therefore keep the original
 * message creation and expiry identity, or the row stops satisfying the
 * canonical work contract that release idempotency checks. The latest request
 * and due times live in the coalesced metadata, not the message identity.
 */
function readPreviousMessageIdentity(previousEntry: ResourceEntry): CoalescedMessageIdentity {
  const message = JSON.parse(previousEntry.resource) as ALMessage;
  return {
    tsEpochMs: message.id.ts,
    expiresAtEpochMs: message.constraints?.expiresAtMs ?? null,
  };
}

/**
 * The M3 change gate applies only to coalesced group-revision recomputes whose
 * request carries a preserve-only topology-config patch; explicit reconfigures
 * and legacy per-command work always rebuild.
 */
export function isChangeGatedGroupRevisionWork(work: PersistedRtcTopologyWork): boolean {
  return (
    work.kind === 'group-revision' &&
    work[COALESCED_APP_OUTBOX_WORK_FIELD] !== undefined &&
    isPreserveOnlyCanonicalGroupTopologyConfigPatch(work.requestOptions)
  );
}

export function mergeRtcTopologyGroupRevisionWork(
  existing: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork>,
  incoming: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork>,
): CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> {
  const previous = existing[COALESCED_APP_OUTBOX_WORK_FIELD];
  const next = incoming[COALESCED_APP_OUTBOX_WORK_FIELD];
  const selected =
    existing.sourceGroupStateRevision > incoming.sourceGroupStateRevision ? existing : incoming;
  return {
    ...incoming,
    groupSnapshot: selected.groupSnapshot,
    sourceGroupStateRevision: selected.sourceGroupStateRevision,
    requestedAtEpochMs: Math.max(existing.requestedAtEpochMs, incoming.requestedAtEpochMs),
    [COALESCED_APP_OUTBOX_WORK_FIELD]: {
      ...next,
      dueAtEpochMs: Math.max(previous.dueAtEpochMs, next.dueAtEpochMs),
      reasons: [...new Set([...previous.reasons, ...next.reasons])],
    },
  };
}

function toRtcTopologyCoalescedGroupRevisionSuccessorResourceId(
  overlayId: string,
  stateRevision: number,
): string {
  return `${overlayId}:group-revision:r${stateRevision}`;
}

function readPreviousCoalescedGroupRevisionEnvelope(
  previousEntry: ResourceEntry,
): CoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork> {
  const envelope =
    tryReadCoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork>(previousEntry);
  if (!envelope || envelope.data.kind !== 'group-revision') {
    throw new TypeError(
      'Coalesced group-revision predecessor is not coalesced topology work: ' +
        previousEntry.key.resourceId,
    );
  }
  return envelope;
}

interface CoalescedMessageIdentity {
  readonly tsEpochMs: number;
  readonly expiresAtEpochMs: number | null;
}

interface ToCoalescedGroupRevisionEntryInput {
  readonly input: RtcTopologyCoalescedGroupRevisionInput;
  readonly resourceId: string;
  readonly data: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork>;
  readonly dequeueAudit: Readonly<{ attempts: number }>;
  readonly entryAudit: ResourceEntry['audit'] | null;
  readonly messageIdentity: CoalescedMessageIdentity | null;
}

function toCoalescedGroupRevisionEntry(
  entryInput: ToCoalescedGroupRevisionEntryInput,
): ResourceEntry {
  const { input, resourceId, data } = entryInput;
  const createdBy = toAppQueueCreatedBy(input.senderId);
  const contextId = groupStateGroupStorageKey(input.aggregateRef);
  const key = toAppQueueKey({
    topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
    resourceId,
    contextId,
  });
  const metadata = data[COALESCED_APP_OUTBOX_WORK_FIELD];
  const messageId = `${resourceId}:g${metadata.generation}`;
  const messageTsEpochMs = entryInput.messageIdentity?.tsEpochMs ?? input.requestedAtEpochMs;
  const messageExpiresAtEpochMs = entryInput.messageIdentity
    ? entryInput.messageIdentity.expiresAtEpochMs
    : input.expireAtEpochMs;
  const envelope: CoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork> = {
    type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
    topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
    resourceId,
    contextId,
    senderId: createdBy,
    data,
  };
  const causalRevision = readGroupCausalRevision(data.groupSnapshot);
  const message: ALMessage = {
    id: {
      v: 2,
      msgId: messageId,
      ts: messageTsEpochMs,
      senderId: createdBy,
    },
    route: key,
    ...(messageExpiresAtEpochMs === null
      ? {}
      : { constraints: { expiresAtMs: messageExpiresAtEpochMs } }),
    ordering: {
      orderingKey: key.contextId,
      epoch: causalRevision.groupRevision,
      seq: causalRevision.presenceRevision,
    },
    delivery: {
      ownership: 'exclusive',
      reliability: 'at-least-once',
      ack: 'none',
    },
    payload: {
      typeId: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
      contentType: 'application/json',
      resource: JSON.stringify(envelope),
    },
    audit: {
      createdBy,
      createdTs: messageTsEpochMs,
    },
  };
  const isDue = metadata.dueAtEpochMs <= input.requestedAtEpochMs;
  const createdTs = Temporal.Instant.fromEpochMilliseconds(messageTsEpochMs)
    .toZonedDateTimeISO('UTC')
    .toPlainDateTime();
  return {
    key,
    resource: JSON.stringify(message),
    typeId: EnqueuedType.APP_OUTBOX,
    status: isDue ? EntityStatus.NEW : EntityStatus.RETRY,
    audit: entryInput.entryAudit ?? {
      date: createdTs.toPlainTime(),
      createdBy,
      createdTs,
      expiryTs: Temporal.Instant.fromEpochMilliseconds(input.expireAtEpochMs),
    },
    dequeueAudit: {
      attempts: entryInput.dequeueAudit.attempts,
      nextTs: isDue ? undefined : Temporal.Instant.fromEpochMilliseconds(metadata.dueAtEpochMs),
    },
  };
}

function validateCoalescedGroupRevisionInput(input: RtcTopologyCoalescedGroupRevisionInput): void {
  const snapshot = input.groupSnapshot;
  validateAuthoritativeGroupSnapshot(snapshot);
  if (
    input.senderId.length === 0 ||
    !Number.isSafeInteger(input.requestedAtEpochMs) ||
    !Number.isSafeInteger(input.expireAtEpochMs) ||
    !Number.isSafeInteger(input.recomputeDebounceMs) ||
    input.requestedAtEpochMs < 0 ||
    input.recomputeDebounceMs < 0 ||
    input.expireAtEpochMs <= input.requestedAtEpochMs ||
    input.aggregateRef.applicationId !== snapshot.group.applicationId ||
    input.aggregateRef.workspaceId !== snapshot.group.workspaceId ||
    input.aggregateRef.groupId !== snapshot.group.groupId
  ) {
    throw new TypeError('Coalesced RTC topology group-revision facts are invalid');
  }
}
