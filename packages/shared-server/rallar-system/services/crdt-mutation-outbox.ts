import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import {
  RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
  RALLAR_CRDT_PROTOCOL_VERSION,
  RALLAR_CRDT_UPDATE_TYPE_ID,
  type RallarCrdtAppendResult,
  type RallarCrdtAuditEvent,
} from '@shared/crdt/mod.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
  DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS,
  RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS,
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from './app-inbox-queue-key.ts';
import type { CrdtAppendCommand } from '../crdt/mutation/crdt-mutation-contracts.ts';

export function toAppendOutbox(
  command: CrdtAppendCommand,
  response: RallarCrdtAppendResult,
  serviceId: string,
  fanout: boolean,
): readonly ResourceEntry[] {
  const reply = toWsOutbox(command, serviceId, 'reply', RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID, {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    requestId: command.update.updateId,
    document: command.document,
    acceptedAtEpochMs: command.capturedAtEpochMs,
    results: [response],
  });
  return fanout
    ? [reply, toWsOutbox(command, serviceId, 'fanout', RALLAR_CRDT_UPDATE_TYPE_ID, command.update)]
    : [reply];
}

export const CRDT_AUDIT_APP_OUTBOX_TYPE = 'CRDT_AUDIT_RECORD';
export const CRDT_AUDIT_APP_OUTBOX_TOPIC = 'rallar.crdt.audit';

export function toCrdtAuditOutbox(
  event: RallarCrdtAuditEvent,
  command:
    | CrdtAppendCommand
    | Readonly<{
        commandId: string;
        capturedAtEpochMs: number;
        expireAtEpochMs: number;
        documentKey: string;
      }>,
  serviceId: string,
): ResourceEntry {
  const auditExpireAtEpochMs = Math.max(
    command.expireAtEpochMs,
    command.capturedAtEpochMs +
      DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS +
      RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS,
  );
  const route = toAppQueueKey({
    topicId: CRDT_AUDIT_APP_OUTBOX_TOPIC,
    resourceId: command.commandId,
    contextId: command.documentKey,
  });
  const message = {
    id: {
      v: 2 as const,
      msgId: command.commandId,
      ts: command.capturedAtEpochMs,
      senderId: serviceId,
    },
    route,
    targets: { mode: 'broadcast' as const, scope: 'all' as const },
    constraints: { expiresAtMs: auditExpireAtEpochMs },
    payload: {
      typeId: CRDT_AUDIT_APP_OUTBOX_TYPE,
      contentType: 'application/json',
      resource: JSON.stringify(event),
    },
    audit: { createdBy: serviceId, createdTs: command.capturedAtEpochMs },
  };
  return toResourceEntry(
    message,
    EnqueuedType.APP_OUTBOX,
    command.capturedAtEpochMs,
    auditExpireAtEpochMs,
    serviceId,
  );
}

function toWsOutbox(
  command: CrdtAppendCommand,
  serviceId: string,
  effect: 'reply' | 'fanout',
  typeId: string,
  payload: unknown,
): ResourceEntry {
  const effectId = effect === 'reply' ? command.deliveryId : command.commandId;
  const message = {
    id: {
      v: 2,
      msgId: `crdt:${effectId}:${effect}`,
      ts: command.capturedAtEpochMs,
      senderId: serviceId,
    },
    route: {
      topicId: command.responseAudience.topicId,
      resourceId: `crdt:${effectId}:${effect}`,
      contextId: command.responseAudience.contextId,
    },
    targets: toTargets(command, effect),
    constraints: { expiresAtMs: command.expireAtEpochMs },
    payload: { typeId, contentType: 'application/json', resource: JSON.stringify(payload) },
    audit: { createdBy: serviceId, createdTs: command.capturedAtEpochMs },
  };
  return toResourceEntry(
    message,
    EnqueuedType.WS_OUTBOX,
    command.capturedAtEpochMs,
    command.expireAtEpochMs,
    serviceId,
  );
}

function toTargets(command: CrdtAppendCommand, effect: 'reply' | 'fanout') {
  if (effect === 'reply' || command.responseAudience.kind === 'principal') {
    return {
      mode: 'unicast' as const,
      toPeerId:
        effect === 'reply' ? command.responseAudience.senderSessionId : command.actor.principalId,
    };
  }
  if (command.responseAudience.kind === 'room' && command.document.roomRef) {
    return {
      mode: 'broadcast' as const,
      scope: 'room' as const,
      groupRef: command.document.roomRef,
      exceptPeerIds: [command.responseAudience.senderSessionId],
    };
  }
  return {
    mode: 'broadcast' as const,
    scope: 'world' as const,
    exceptPeerIds: [command.responseAudience.senderSessionId],
  };
}

function toResourceEntry(
  message: { route: ResourceEntry['key'] },
  typeId: EnqueuedType,
  created: number,
  expiry: number,
  serviceId: string,
): ResourceEntry {
  const createdTs = Temporal.Instant.fromEpochMilliseconds(created)
    .toZonedDateTimeISO('UTC')
    .toPlainDateTime();
  return {
    key: message.route,
    resource: JSON.stringify(message),
    typeId,
    status: EntityStatus.NEW,
    audit: {
      date: createdTs.toPlainTime(),
      createdBy: toAppQueueCreatedBy(serviceId),
      createdTs,
      expiryTs: Temporal.Instant.fromEpochMilliseconds(expiry),
    },
    dequeueAudit: { attempts: 0 },
  };
}
