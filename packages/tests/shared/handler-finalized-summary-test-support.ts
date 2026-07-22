import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
  computeGroupPresenceSummaryEntry,
  type GroupPresenceSummaryWorkData,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';

export type HandlerFinalizedSummaryScenario = Readonly<{
  name: string;
  accepted: boolean;
  entries(): Readonly<{
    reserved: ResourceEntry;
    current: ResourceEntry;
  }>;
}>;

const MANDATORY_WORK_KEYS = [
  'effectKind',
  'aggregateRef',
  'commandId',
  'createdAtEpochMs',
  'expireAtEpochMs',
  'acceptedCausalRevision',
  'event',
] as const;

export const HANDLER_FINALIZED_SUMMARY_SCENARIOS: readonly HandlerFinalizedSummaryScenario[] = [
  scenario('exact canonical summary family', true),
  scenario('unrelated APP_OUTBOX family', false, (reserved) => ({
    ...reserved,
    key: {
      topicId: 'app-outbox.unrelated',
      resourceId: 'unrelated-resource',
      contextId: 'unrelated-context',
    },
    resource: JSON.stringify({ family: 'unrelated' }),
  })),
  scenario('wrong summary topic', false, (reserved) =>
    updateMessage(reserved, (message) => ({
      ...message,
      route: { ...message.route, topicId: 'app-outbox.wrong-summary' },
    })),
  ),
  scenario('wrong outer payload type', false, (reserved) =>
    updateMessage(reserved, (message) => ({
      ...message,
      payload: { ...message.payload, typeId: 'RTC_TOPOLOGY_RECOMPUTE' },
    })),
  ),
  scenario('wrong nested envelope family', false, (reserved) =>
    updateEnvelope(reserved, (envelope) => ({
      ...envelope,
      type: 'RTC_TOPOLOGY_RECOMPUTE',
    })),
  ),
  scenario('reviewer reproduction: wrong nested resource identity', false, (reserved) =>
    updateEnvelope(reserved, (envelope) => ({
      ...envelope,
      resourceId: 'reviewer-wrong-resource',
    })),
  ),
  scenario('reviewer reproduction: wrong nested context identity', false, (reserved) =>
    updateEnvelope(reserved, (envelope) => ({
      ...envelope,
      contextId: 'reviewer-wrong-context',
    })),
  ),
  scenario('reviewer reproduction: empty nested sender identity', false, (reserved) =>
    updateEnvelope(reserved, (envelope) => ({
      ...envelope,
      senderId: '',
    })),
  ),
  scenario('reviewer reproduction: effect-only work data', false, (reserved) =>
    updateEnvelope(reserved, (envelope) => ({
      ...envelope,
      data: { effectKind: 'group-presence-summary' },
    })),
  ),
  ...mandatoryWorkKeyScenarios(),
  scenario('wrong command-derived resource identity', false, (reserved) =>
    updateCanonicalIdentity(reserved, {
      resourceId: 'wrong-command-derived-resource',
    }),
  ),
  scenario('wrong GroupRef-derived context identity', false, (reserved) =>
    updateCanonicalIdentity(reserved, {
      contextId: 'wrong-group-ref-derived-context',
    }),
  ),
  scenario('event requestId differs from commandId', false, (reserved) =>
    updateEvent(reserved, (event) => ({
      ...event,
      requestId: 'wrong-event-request',
    })),
  ),
  scenario('event occurrence differs from command creation', false, (reserved) =>
    updateEvent(reserved, (event) => ({
      ...event,
      occurredAtEpochMs: 1_001,
    })),
  ),
  scenario('event causal revision differs from accepted causal revision', false, (reserved) =>
    updateEvent(reserved, (event) => ({
      ...event,
      causalRevision: {
        groupRevision: 3,
        presenceRevision: 3,
      },
    })),
  ),
  scenario('event is missing a mandatory actor', false, (reserved) =>
    updateEvent(reserved, (event) => removeKey(event, 'actor')),
  ),
  scenario('event actor has an incomplete service identity', false, (reserved) =>
    updateEvent(reserved, (event) => ({
      ...event,
      actor: { kind: 'service' },
    })),
  ),
  scenario('ordering differs from accepted causal revision', false, (reserved) =>
    updateMessage(reserved, (message) => ({
      ...message,
      ordering: { ...message.ordering, epoch: 4 },
    })),
  ),
  scenario('message timestamp differs from command creation', false, (reserved) =>
    updateMessage(reserved, (message) => ({
      ...message,
      id: { ...message.id, ts: 1_001 },
    })),
  ),
  scenario('message expiry differs from command expiry', false, (reserved) =>
    updateMessage(reserved, (message) => ({
      ...message,
      constraints: { ...message.constraints, expiresAtMs: 2_000 },
    })),
  ),
  scenario('message audit differs from nested sender', false, (reserved) =>
    updateMessage(reserved, (message) => ({
      ...message,
      audit: { ...message.audit, createdBy: 'wrong-message-audit' },
    })),
  ),
  scenario('entry audit differs from nested sender', false, (reserved) => ({
    ...reserved,
    audit: { ...reserved.audit, createdBy: 'wrong-entry-audit' },
  })),
  scenario('entry audit timestamp differs from command creation', false, (reserved) => ({
    ...reserved,
    audit: {
      ...reserved.audit,
      createdTs: Temporal.PlainDateTime.from('2000-01-01T00:00:00'),
    },
  })),
  scenario('malformed summary JSON', false, (reserved) => ({
    ...reserved,
    resource: '{',
  })),
  scenario('changed immutable summary resource', false, undefined, (current) =>
    updateEnvelope(current, (envelope) => ({
      ...envelope,
      senderId: 'changed-after-handler-finalization',
    })),
  ),
  scenario('changed immutable audit after handler finalization', false, undefined, (current) => ({
    ...current,
    audit: {
      ...current.audit,
      createdBy: 'changed-audit',
    },
  })),
  scenario('wrong completed attempt', false, undefined, (current) => ({
    ...current,
    dequeueAudit: {
      ...current.dequeueAudit,
      attempts: current.dequeueAudit.attempts + 1,
    },
  })),
  scenario('wrong finalized status', false, undefined, (current) => ({
    ...current,
    status: EntityStatus.FAILED,
  })),
];

function mandatoryWorkKeyScenarios(): readonly HandlerFinalizedSummaryScenario[] {
  return MANDATORY_WORK_KEYS.map((key) =>
    scenario(`missing mandatory work key: ${key}`, false, (reserved) =>
      updateWork(reserved, (work) => removeKey(work, key)),
    ),
  );
}

function scenario(
  name: string,
  accepted: boolean,
  mutateReserved?: (entry: ResourceEntry) => ResourceEntry,
  mutateCurrent?: (entry: ResourceEntry) => ResourceEntry,
): HandlerFinalizedSummaryScenario {
  return {
    name,
    accepted,
    entries: () => {
      const canonical = createReservedSummaryEntry();
      const reserved = mutateReserved?.(canonical) ?? canonical;
      const completed: ResourceEntry = {
        ...reserved,
        status: EntityStatus.COMPLETED,
        dequeueAudit: {
          ...reserved.dequeueAudit,
          endTs: Temporal.Instant.fromEpochMilliseconds(1_100),
        },
      };
      return {
        reserved,
        current: mutateCurrent?.(completed) ?? completed,
      };
    },
  };
}

function createReservedSummaryEntry(): ResourceEntry {
  const work: GroupPresenceSummaryWorkData = {
    effectKind: 'group-presence-summary',
    aggregateRef: {
      applicationId: 'handler-finalized-app',
      workspaceId: 'main',
      groupId: 'handler-finalized-group',
    },
    commandId: 'handler-finalized-command',
    createdAtEpochMs: 1_000,
    expireAtEpochMs: 253_402_300_799_999,
    acceptedCausalRevision: {
      groupRevision: 3,
      presenceRevision: 2,
    },
    event: {
      applicationId: 'handler-finalized-app',
      workspaceId: 'main',
      groupId: 'handler-finalized-group',
      eventId: 'handler-finalized-event',
      eventType: 'session-connected',
      snapshotVersion: 3,
      causalRevision: {
        groupRevision: 3,
        presenceRevision: 2,
      },
      occurredAtEpochMs: 1_000,
      actor: { kind: 'service', serviceId: 'handler-test' },
      reason: null,
      traceId: null,
      requestId: 'handler-finalized-command',
      payload: {},
    },
  };
  const entry = computeGroupPresenceSummaryEntry(work, 'handler-test');
  return {
    ...entry,
    typeId: EnqueuedType.APP_OUTBOX,
    status: EntityStatus.RESERVED,
    dequeueAudit: {
      attempts: 4,
      startTs: Temporal.Instant.fromEpochMilliseconds(1_050),
    },
  };
}

function updateMessage(
  entry: ResourceEntry,
  update: (message: ALMessage) => ALMessage,
): ResourceEntry {
  const message = JSON.parse(entry.resource) as ALMessage;
  return { ...entry, resource: JSON.stringify(update(message)) };
}

function updateEnvelope(
  entry: ResourceEntry,
  update: (envelope: Record<string, unknown>) => Record<string, unknown>,
): ResourceEntry {
  return updateMessage(entry, (message) => {
    const envelope = JSON.parse(message.payload.resource) as Record<string, unknown>;
    return {
      ...message,
      payload: {
        ...message.payload,
        resource: JSON.stringify(update(envelope)),
      },
    };
  });
}

function updateWork(
  entry: ResourceEntry,
  update: (work: Record<string, unknown>) => Record<string, unknown>,
): ResourceEntry {
  return updateEnvelope(entry, (envelope) => ({
    ...envelope,
    data: update(envelope.data as Record<string, unknown>),
  }));
}

function updateEvent(
  entry: ResourceEntry,
  update: (event: Record<string, unknown>) => Record<string, unknown>,
): ResourceEntry {
  return updateWork(entry, (work) => ({
    ...work,
    event: update(work.event as Record<string, unknown>),
  }));
}

function updateCanonicalIdentity(
  entry: ResourceEntry,
  identity: Readonly<{ resourceId?: string; contextId?: string }>,
): ResourceEntry {
  const resourceId = identity.resourceId ?? entry.key.resourceId;
  const contextId = identity.contextId ?? entry.key.contextId;
  const updated = updateEnvelope(entry, (envelope) => ({
    ...envelope,
    resourceId,
    contextId,
  }));
  const message = JSON.parse(updated.resource) as ALMessage;
  const key = { ...updated.key, resourceId, contextId };
  return {
    ...updated,
    key,
    resource: JSON.stringify({
      ...message,
      id: { ...message.id, msgId: resourceId },
      route: key,
    }),
  };
}

function removeKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}
