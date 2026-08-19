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

import { toAppQueueCreatedBy, toAppQueueKey } from '../../services/app-inbox-queue-key.ts';
import type { CrdtAppendCommand } from './crdt-mutation-contracts.ts';

interface AppendOutboxInput {
  readonly command: CrdtAppendCommand;
  readonly response: RallarCrdtAppendResult;
  readonly serviceId: string;
  readonly fanout: boolean;
}

interface WsOutboxInput {
  readonly command: CrdtAppendCommand;
  readonly serviceId: string;
  readonly effect: 'reply' | 'fanout';
  readonly typeId: string;
  readonly payload: unknown;
}

interface ResourceEntryInput {
  readonly message: { readonly route: ResourceEntry['key'] };
  readonly typeId: EnqueuedType;
  readonly created: number;
  readonly expiry: number;
  readonly serviceId: string;
}

export function toAppendOutbox(input: AppendOutboxInput): readonly ResourceEntry[] {
  const { command, response, serviceId, fanout } = input;
  const reply = toWsOutbox({
    command,
    serviceId,
    effect: 'reply',
    typeId: RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
    payload: {
      protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
      requestId: command.update.updateId,
      document: command.document,
      acceptedAtEpochMs: command.capturedAtEpochMs,
      results: [response],
    },
  });
  return fanout
    ? [
        reply,
        toWsOutbox({
          command,
          serviceId,
          effect: 'fanout',
          typeId: RALLAR_CRDT_UPDATE_TYPE_ID,
          payload: command.update,
        }),
      ]
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
  return toResourceEntry({
    message,
    typeId: EnqueuedType.APP_OUTBOX,
    created: command.capturedAtEpochMs,
    expiry: auditExpireAtEpochMs,
    serviceId,
  });
}

function toWsOutbox(input: WsOutboxInput): ResourceEntry {
  const { command, serviceId, effect, typeId, payload } = input;
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
  return toResourceEntry({
    message,
    typeId: EnqueuedType.WS_OUTBOX,
    created: command.capturedAtEpochMs,
    expiry: command.expireAtEpochMs,
    serviceId,
  });
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

function toResourceEntry(input: ResourceEntryInput): ResourceEntry {
  const { message, typeId, created, expiry, serviceId } = input;
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
