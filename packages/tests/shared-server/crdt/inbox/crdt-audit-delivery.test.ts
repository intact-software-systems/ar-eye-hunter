import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import {
  newALRoute,
  newALUntargetedMessage,
  type ALMessage,
} from '@shared/al-contracts/al-contract.ts';
import type { RallarCrdtAuditEvent, RallarCrdtAuditSink } from '@shared/crdt/mod.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { AppCrdtInboxService } from '@shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts';
import { registerCrdtAuditDelivery } from '@shared-server/rallar-system/crdt/inbox/register-crdt-audit-delivery.ts';
import type { CrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';

import { CRDT_AUDIT_APP_OUTBOX_TYPE } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-outbox.ts';

const EVENT: RallarCrdtAuditEvent = {
  kind: 'erase',
  atEpochMs: 1_000,
  documentKey: 'document-1',
  principalId: 'principal-1',
  reason: 'privacy',
  metadata: { mode: 'destroy-document' },
};

describe('CRDT audit delivery', () => {
  it('registers no audit callback when construction omits the complete delivery pair', () => {
    const outboxQueueReader = new RecordingOutboxQueueReader();

    const inbox = createInbox({ outboxQueueReader, auditDelivery: undefined });

    expect(inbox).toBeInstanceOf(AppCrdtInboxService);
    expect(outboxQueueReader.registeredTypes).toEqual([]);
  });

  it('registers the audit callback only from a complete immutable delivery pair', () => {
    const outboxQueueReader = new RecordingOutboxQueueReader();
    const auditSink: RallarCrdtAuditSink = { record: () => undefined };

    createInbox({
      outboxQueueReader,
      auditDelivery: { outboxQueueReader, auditSink },
    });

    expect(outboxQueueReader.registeredTypes).toEqual([CRDT_AUDIT_APP_OUTBOX_TYPE]);
  });

  it('propagates content, decoding, and sink failures without hiding delivery retry', async () => {
    const outboxQueueReader = new RecordingOutboxQueueReader();
    const sinkFailure = new Error('audit sink unavailable');
    const record = vi.fn(() => {
      throw sinkFailure;
    });
    registerCrdtAuditDelivery({ outboxQueueReader, auditSink: { record } });
    const handler = outboxQueueReader.requireHandler(CRDT_AUDIT_APP_OUTBOX_TYPE);
    const wrongContentType = createAuditMessage(EVENT);
    Reflect.set(wrongContentType.payload, 'contentType', 'text/plain');
    const malformedJson = createAuditMessage(EVENT);
    Reflect.set(malformedJson.payload, 'resource', '{');

    await expect(handler.onMessage(wrongContentType, createResourceEntry())).rejects.toThrow(
      'CRDT audit outbox content type is invalid',
    );
    await expect(handler.onMessage(malformedJson, createResourceEntry())).rejects.toBeInstanceOf(
      SyntaxError,
    );
    await expect(
      handler.onMessage(createAuditMessage({ ...EVENT, kind: 'append' }), createResourceEntry()),
    ).rejects.toThrow('CRDT audit outbox event is invalid');
    await expect(handler.onMessage(createAuditMessage(EVENT), createResourceEntry())).rejects.toBe(
      sinkFailure,
    );
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(EVENT);
  });

  it('records the decoded event once for each successful handler invocation', async () => {
    const outboxQueueReader = new RecordingOutboxQueueReader();
    const record = vi.fn(() => undefined);
    registerCrdtAuditDelivery({ outboxQueueReader, auditSink: { record } });
    const handler = outboxQueueReader.requireHandler(CRDT_AUDIT_APP_OUTBOX_TYPE);

    await handler.onMessage(createAuditMessage(EVENT), createResourceEntry());
    await handler.onMessage(createAuditMessage(EVENT), createResourceEntry());

    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls).toEqual([[EVENT], [EVENT]]);
  });
});

interface CreateInboxInput {
  readonly outboxQueueReader: RecordingOutboxQueueReader;
  readonly auditDelivery: AppCrdtInboxService.AuditDelivery | undefined;
}

function createInbox(input: CreateInboxInput): AppCrdtInboxService {
  const database = createUnusedDatabase();
  return new AppCrdtInboxService(
    {
      inboxQueueReader: new InboxQueueReader(new InMemoryQueueBox()),
      outboxQueueReader: input.outboxQueueReader,
      resourceInboxRepository: new ResourceInboxRepository(database),
      resourceInboxResultsRepository: new ResourceInboxResultsRepository(database),
      database,
      mutationService: createMutationService(),
      readCurrentSession: () => Promise.reject(new Error('not read')),
      wakeQueueEngine: () => undefined,
      auditDelivery: input.auditDelivery,
    },
    {
      serviceId: 'server-1',
      timing: undefined,
      appInbox: {},
    },
  );
}

function createUnusedDatabase(): PSqlSql {
  const database = (() =>
    Promise.reject(new Error('Unexpected SQL execution in audit registration test'))) as PSqlSql;
  database.begin = () =>
    Promise.reject(new Error('Unexpected transaction in audit registration test'));
  return database;
}

function createMutationService(): CrdtMutationService {
  return {
    read: () => Promise.reject(new Error('not read')),
    compute: () => {
      throw new Error('not computed');
    },
    validate: () => [],
    write: () => Promise.reject(new Error('not written')),
  };
}

class RecordingOutboxQueueReader extends OutboxQueueReader {
  readonly registeredTypes: string[] = [];
  private readonly handlers = new Map<string, OnMessageCallback>();

  constructor() {
    super(new InMemoryQueueBox());
  }

  override onOutboxMessageDo(type: string, callback: OnMessageCallback): this {
    this.registeredTypes.push(type);
    this.handlers.set(type, callback);
    return this;
  }

  requireHandler(type: string): OnMessageCallback {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`Expected ${type} audit handler registration`);
    }
    return handler;
  }
}

function createAuditMessage(event: unknown): ALMessage {
  return newALUntargetedMessage(
    'server-1',
    newALRoute('crdt.audit', 'document-1', 'audit-1'),
    CRDT_AUDIT_APP_OUTBOX_TYPE,
    event,
  );
}

function createResourceEntry(): ResourceEntry {
  return {
    key: { topicId: 'crdt.audit', resourceId: 'audit-1', contextId: 'document-1' },
    resource: '{}',
    typeId: 'APP_OUTBOX',
    audit: {
      date: Temporal.PlainTime.from('00:00:00'),
      createdBy: 'server-1',
      createdTs: Temporal.PlainDateTime.from('1970-01-01T00:00:01'),
      expiryTs: Temporal.Instant.fromEpochMilliseconds(61_000),
    },
    status: EntityStatus.RESERVED,
    dequeueAudit: { attempts: 1 },
  };
}
