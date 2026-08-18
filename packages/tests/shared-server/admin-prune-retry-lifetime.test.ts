import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS,
  RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS,
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
  AdminPruneExpiredWork,
  type AdminPruneExpiredRepository,
  type AdminPrunePageRead,
  type ReservedAdminPrunePageWork,
} from '@shared-server/rallar-system/admin-operations/AdminPruneExpiredWork.ts';
import { createAdminPruneAggregate } from '@shared-server/rallar-system/admin-operations/admin-prune-progress.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';

const NOW = 1_700_000_000_000;
const RETRY_LIFETIME =
  DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS + RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS;

describe('admin prune retry lifetime', () => {
  it('gives every successor and pending result a complete 20-attempt retry horizon', () => {
    const service = new AdminPruneExpiredWork({
      database: createDatabase(),
      repository: createRepository(),
      serviceId: 'server-1',
      pageSize: 2,
      now: () => NOW,
      readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' }),
    });
    const command = createReservedCommand();
    const aggregate = createAdminPruneAggregate({
      jobId: command.jobId,
      generatedAtEpochMs: command.capturedAtEpochMs,
      expireAtEpochMs: command.expireAtEpochMs,
      serverId: 'server-1',
      requestedBy: command.requestedBy,
      requestedSessionId: command.requestedSessionId,
      categories: [command.category],
      expiredRows: { 'runtime-state': 3 },
    });
    const read: AdminPrunePageRead = {
      rowIds: ['1', '2'],
      hasMore: true,
      aggregate,
      expectedAggregate: JSON.stringify(aggregate),
      authority: { allowed: true, code: 'allowed' },
      nowEpochMs: NOW,
    };

    const computed = service.compute(command, read);

    expect(computed.next?.expireAtEpochMs).toBe(NOW + RETRY_LIFETIME);
    expect(Number(computed.aggregateSuccessor.audit.expiryTs.epochMilliseconds)).toBe(
      NOW + RETRY_LIFETIME,
    );
  });
});

function createReservedCommand(): ReservedAdminPrunePageWork {
  return {
    kind: 'page',
    jobId: 'job-1',
    category: 'runtime-state',
    requestedBy: 'admin-1',
    requestedSessionId: 'session-1',
    capturedAtEpochMs: NOW - 1,
    expireAtEpochMs: NOW + RETRY_LIFETIME,
    pageSize: 2,
    afterCursor: null,
    pageIndex: 0,
    appData: null,
    reservation: createReservation(),
  };
}

function createReservation(): ResourceEntry {
  return {
    key: { topicId: 'admin-prune', resourceId: 'job-1', contextId: 'runtime-state' },
    resource: '{}',
    typeId: 'APP_OUTBOX',
    audit: {
      date: Temporal.PlainTime.from('00:00:00'),
      createdBy: 'server-1',
      createdTs: Temporal.PlainDateTime.from('2023-11-14T00:00:00'),
      expiryTs: Temporal.Instant.fromEpochMilliseconds(NOW + RETRY_LIFETIME),
    },
    status: EntityStatus.RESERVED,
    dequeueAudit: { attempts: 1 },
  };
}

function createDatabase(): PSqlSql {
  const database = (() =>
    Promise.reject(new Error('Unexpected SQL execution in admin prune compute test'))) as PSqlSql;
  database.begin = () =>
    Promise.reject(new Error('Unexpected transaction in admin prune compute test'));
  return database;
}

function createRepository(): AdminPruneExpiredRepository {
  return {
    readPage: () => Promise.reject(new Error('not read')),
    readAggregate: () => Promise.reject(new Error('not read')),
    deletePage: () => Promise.reject(new Error('not written')),
    writeOutbox: () => Promise.reject(new Error('not written')),
    writeProgress: () => Promise.reject(new Error('not written')),
    finishReserved: () => Promise.reject(new Error('not written')),
  };
}
