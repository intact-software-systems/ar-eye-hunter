import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createAdminPruneCommand } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import {
    computeAdminPruneMutation,
    validateAdminPruneMutation
} from '@shared-server/rallar-system/admin-operations/inbox/compute-admin-prune-mutation.ts';
import { writeAdminPruneAggregate } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-prune-repository.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

describe('admin prune computation', () => {
    it('computes persistence-ready domain and completion writes before the transaction', async () => {
        const read = await createRead();

        const computed = computeAdminPruneMutation(read);

        expect(computed.result).toMatchObject({
            status: 'queued',
            serverId: 'admin-server',
            jobId: 'prune-job'
        });
        expect(computed.outboxWrites).toEqual([
            expect.objectContaining({
                entry: expect.objectContaining({ typeId: 'APP_OUTBOX' }),
                systemDate: expect.any(String),
                createdAt: expect.any(String),
                expiresAt: expect.any(String)
            })
        ]);
        expect(computed.aggregateWrite).toEqual(expect.objectContaining({
            entry: expect.objectContaining({ resource: expect.any(String) }),
            systemDate: expect.any(String),
            createdAt: expect.any(String),
            expiresAt: expect.any(String)
        }));
        expect(computed.completion.durableResult).toBe(computed.result);
        expect(computed.completion.reservationFinish.completedAt).toEqual(new Date(1_010));
        expect(validateAdminPruneMutation(read, computed)).toEqual([]);
    });

    it('validates the supplied computation without replacing it', async () => {
        const read = await createRead();
        const computed = computeAdminPruneMutation(read);
        const changed = {
            ...computed,
            result: { ...computed.result, jobId: 'another-job' }
        };

        const issues = validateAdminPruneMutation(read, changed);

        expect(issues).toContainEqual(expect.objectContaining({
            code: 'admin-prune-computed-identity-invalid',
            status: 400
        }));
        expect(changed.result.jobId).toBe('another-job');
    });

    it('rejects prepared admin prune rows that differ from the computed mutation', async () => {
        const read = await createRead();
        const computed = computeAdminPruneMutation(read);
        const firstOutboxWrite = computed.outboxWrites[0];
        if (firstOutboxWrite === undefined || computed.aggregateWrite === null) {
            throw new TypeError('Expected prepared admin prune writes');
        }
        const tampered = [
            {
                ...computed,
                outboxWrites: [{ ...firstOutboxWrite, expiresAt: '2000-01-01T00:00:00.000Z' }]
            },
            {
                ...computed,
                aggregateWrite: {
                    ...computed.aggregateWrite,
                    createdAt: '2000-01-01T00:00:00.000Z'
                }
            },
            {
                ...computed,
                aggregateWrite: {
                    ...computed.aggregateWrite,
                    entry: { ...computed.aggregateWrite.entry, resource: '{"jobId":"tampered"}' }
                }
            }
        ];

        for (const candidate of tampered) {
            expect(validateAdminPruneMutation(read, candidate)).toContainEqual(expect.objectContaining({
                code: 'admin-prune-computed-persistence-invalid',
                status: 400
            }));
        }
    });

    it('writes the prepared aggregate without formatting timestamps in the transaction', async () => {
        const computed = computeAdminPruneMutation(await createRead());
        const aggregateWrite = computed.aggregateWrite;
        if (aggregateWrite === null) {
            throw new Error('Expected a durable admin prune aggregate');
        }
        const transaction = ((parts: TemplateStringsArray) => {
            const statement = parts.join(' ');
            return Promise.resolve(
                statement.includes('insert into resource_inbox_results')
                    ? [{ ris_resource: aggregateWrite.entry.resource }]
                    : []
            );
        }) as PSqlSql;
        const originalToString = Temporal.Instant.prototype.toString;

        Temporal.Instant.prototype.toString = rejectTimestampFormattingDuringWrite;
        try {
            await writeAdminPruneAggregate(transaction, aggregateWrite);
        }
        finally {
            Temporal.Instant.prototype.toString = originalToString;
        }
    });
});

function rejectTimestampFormattingDuringWrite(): never {
    throw new TypeError('Admin prune aggregate timestamp formatted inside write');
}

async function createRead() {
    const command = await createAdminPruneCommand({
        jobId: 'prune-job',
        requestedBy: 'admin',
        requestedSessionId: 'session',
        capturedAtEpochMs: 1_000,
        expireAtEpochMs: 100_000,
        dryRun: false,
        categories: ['runtime-state'],
        appData: null,
        pageSize: 25
    });
    const entry: ResourceEntry = {
        key: { topicId: 'ADMIN_PRUNE_EXPIRED', resourceId: 'prune-job', contextId: 'admin' },
        resource: '{}',
        typeId: 'APP_INBOX',
        status: EntityStatus.RESERVED,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'admin-server',
            createdTs: Temporal.PlainDateTime.from('2026-08-07T12:00:00'),
            expiryTs: Temporal.Instant.from('2026-08-07T13:00:00Z')
        },
        dequeueAudit: { attempts: 1 }
    };
    return {
        command,
        expiredRows: {
            'runtime-state': 3,
            'resource-inbox': 0,
            'resource-inbox-results': 0,
            'app-data': 0
        },
        authority: { allowed: true, code: 'allowed' },
        nowEpochMs: 1_005,
        serviceId: 'admin-server',
        completionFacts: { entry, completedAtEpochMs: 1_010 }
    };
}
