import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import type { PSqlRows } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import type {
    ApiV1StateWriteEvidenceQuery,
    ApiV1StateWriteEvidenceSql,
    ApiV1StateWriteEvidenceSqlParameter,
    InboxRow
} from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-contracts.ts';
import { parseApiV1StateWriteEvidenceRow } from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-derivation.ts';
import { collectApiV1StateWriteEvidenceFromSql } from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-sql.ts';
import type { ResourceInboxFairnessSelection } from '@shared/queuebox/queue-box-types.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { createPSqlAdmissionTestStorage } from '../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';

interface OverdueFixtureObservationCase {
    readonly name: string;
    readonly beforeAttempts: number;
    readonly otherScope: boolean;
    readonly naturalCount: number;
    readonly naturalContext: string | null;
}

const COMPLETED_ENTRY: ResourceEntry = {
    key: {
        topicId: 'app-inbox-topology',
        contextId: 'fixture-scope',
        resourceId: 'put-final-config-fixture-scope'
    },
    typeId: 'APP_INBOX',
    resource: JSON.stringify({
        payload: {
            typeId: 'TOPOLOGY_CONFIG_PUT',
            resource: JSON.stringify({ requestId: 'put-final-config-fixture-scope' })
        }
    }),
    status: EntityStatus.COMPLETED,
    audit: {
        createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00.123456'),
        createdBy: 'fixture-owner',
        date: Temporal.PlainTime.from('12:00:00.123456'),
        expiryTs: NEVER_EXPIRE_TS
    },
    dequeueAudit: {
        attempts: 1,
        startTs: Temporal.Instant.from('2026-01-01T12:00:01.123456Z'),
        endTs: Temporal.Instant.from('2026-01-01T12:00:02.123456Z')
    }
};

describe('state-write overdue fixture lifecycle', () => {
    it.each([
        {
            timestamp: new Date('2026-01-01T14:00:01.123+02:00'),
            expected: '2026-01-01T12:00:01.123Z'
        },
        {
            timestamp: '2026-01-01 12:00:01.123456',
            expected: '2026-01-01T12:00:01.123456Z'
        }
    ])(
        'reports absolute Date and UTC wall-clock timestamps exactly: $expected',
        ({ timestamp, expected }) => {
            const row: InboxRow = {
                ri_row_id: 1,
                ri_resource_id: 'timing-projection',
                ri_topic_id: 'timing-projection',
                fk_ext_bank_id: 'timing-projection',
                ri_resource: '{}',
                ri_status: 'COMPLETED',
                ri_attempts: 1,
                start_ts: timestamp,
                end_ts: timestamp,
                next_ts: null,
                result_status: 'COMPLETED',
                result_resource: '{}'
            };
            const parsed = parseApiV1StateWriteEvidenceRow(row);
            expect(parsed.startAt).toBe(expected);
            expect(parsed.endAt).toBe(expected);
            expect(parsed.nextAt).toBeNull();
        }
    );

    it.each<OverdueFixtureObservationCase>([
        { name: 'synthetic retry only', beforeAttempts: 1, otherScope: false, naturalCount: 0, naturalContext: null },
        { name: 'pre-existing retry on fixture row', beforeAttempts: 2, otherScope: false, naturalCount: 1, naturalContext: 'fixture-scope' },
        { name: 'same resource id in another scope', beforeAttempts: 1, otherScope: true, naturalCount: 1, naturalContext: 'fixture-other-scope' }
    ])('preserves natural observations and exact overdue completion: $name', async ({ beforeAttempts, otherScope, naturalCount, naturalContext }) => {
        const { sql } = await createPSqlAdmissionTestStorage();
        await sql.exec('set time zone \'Etc/GMT-3\'');
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
        const results = new ResourceInboxResultsRepository(sql);
        const completedEntry = { ...COMPLETED_ENTRY, dequeueAudit: { ...COMPLETED_ENTRY.dequeueAudit, attempts: beforeAttempts } };
        await queue.enqueue(completedEntry);
        await results.replace({ ...completedEntry, resource: '{}' });
        if (otherScope) {
            const sibling = {
                ...COMPLETED_ENTRY,
                key: { ...COMPLETED_ENTRY.key, contextId: 'fixture-other-scope' },
                dequeueAudit: { ...COMPLETED_ENTRY.dequeueAudit, attempts: 2 }
            };
            await queue.enqueue(sibling);
            await results.replace({ ...sibling, resource: '{}' });
        }
        const original = await repository.entries.findAnyByKey(COMPLETED_ENTRY.key);
        expect(original?.dequeueAudit.attempts).toBe(beforeAttempts);
        let selectedReadback: ResourceInboxFairnessSelection | undefined;

        async function query<Rows extends PSqlRows>(
            strings: TemplateStringsArray,
            ...values: readonly ApiV1StateWriteEvidenceSqlParameter[]
        ): Promise<Rows> {
            return await sql<Rows>(strings, ...values);
        }
        const evidenceSql: ApiV1StateWriteEvidenceSql = Object.assign(query, {
            begin: async (
                write: (transaction: ApiV1StateWriteEvidenceQuery) => Promise<void>
            ) => {
                await sql.begin(write);
                const retry = await repository.entries.findAnyByKey(
                    COMPLETED_ENTRY.key
                );
                expect(retry?.status).toBe('RETRY');
                expect(retry?.dequeueAudit).toEqual({
                    attempts: beforeAttempts,
                    startTs: original?.dequeueAudit.startTs,
                    endTs: original?.dequeueAudit.endTs,
                    nextTs: expect.any(Temporal.Instant)
                });
                expect(retry?.audit).toEqual(original?.audit);
                expect(retry?.key).toEqual(COMPLETED_ENTRY.key);
                const cutoff = Date.now() - 30_000;
                const [eligibility] = await sql<readonly { due: boolean; live: boolean; }[]>`
                    select next_ts <= ${new Date(cutoff)} as due,
                           expire_ts > (now() at time zone 'UTC') as live
                    from resource_inbox where ri_resource_id = ${COMPLETED_ENTRY.key.resourceId}
                      and fk_ext_bank_id = ${COMPLETED_ENTRY.key.contextId}
                      and ri_topic_id = ${COMPLETED_ENTRY.key.topicId}
                `;
                expect(eligibility?.due).toBe(true);
                expect(eligibility?.live).toBe(true);
                const selected = [...(await queue.reserveOverdueRetryEntries(
                    new Set(['APP_INBOX']),
                    cutoff,
                    { maxToReserve: 1, maxToScan: 1, maxAttempts: 5 }
                )).values()][0];
                expect(selected?.selectedDueTs).toEqual(retry?.dequeueAudit.nextTs);
                expect(selected?.entry.status).toBe('RESERVED');
                expect(selected?.entry.dequeueAudit.attempts).toBe(beforeAttempts + 1);
                if (!selected) {
                    throw new Error(
                        'Actual fixture was not available for overdue pickup'
                    );
                }
                selectedReadback = selected;
                const completed = [...(await queue.releaseEntries([{
                    entry: selected.entry,
                    disposition: { status: EntityStatus.COMPLETED, delayMs: null }
                }])).values()][0];
                if (!completed) {
                    throw new Error('Overdue pickup did not complete');
                }
                await results.replace({ ...completed, resource: '{}' });
            }
        });

        const evidence = await collectApiV1StateWriteEvidenceFromSql({
            match: 'fixture-scope',
            overdueRecoveryFixture: {
                commandType: 'TOPOLOGY_CONFIG_PUT',
                commandIdPrefix: 'put-final-config-',
                overdueByMs: 65_000,
                timeoutMs: 20_000
            }
        }, evidenceSql);

        expect(evidence.overdueRecoveryFixture).toMatchObject({
            beforeStatus: 'COMPLETED',
            beforeAttempts,
            afterStatus: 'COMPLETED',
            afterResultStatus: 'COMPLETED',
            afterAttempts: beforeAttempts + 1,
            recovered: true,
            overdueAtClaim: true,
            notBeforeSatisfied: true
        });
        expect(
            (await repository.entries.findAnyByKey(COMPLETED_ENTRY.key))?.dequeueAudit
                .attempts
        ).toBe(beforeAttempts + 1);
        expect(evidence).toMatchObject({
            naturalBoundedRetryCount: naturalCount,
            naturalBoundedRetryObserved: naturalCount > 0,
            naturalRetryEvidenceGap: naturalCount === 0,
            naturalBoundedRetries: naturalContext === null ? [] : [{
                resourceId: COMPLETED_ENTRY.key.resourceId,
                contextId: naturalContext,
                attempts: 2,
                startAt: '2026-01-01T12:00:01.123456Z',
                endAt: '2026-01-01T12:00:02.123456Z',
                status: 'COMPLETED',
                resultStatus: 'COMPLETED'
            }]
        });
        const fixture = evidence.overdueRecoveryFixture;
        if (
            !fixture || typeof fixture !== 'object' ||
            !('injectedDueAt' in fixture) ||
            typeof fixture.injectedDueAt !== 'string' ||
            !('claimedAt' in fixture) || typeof fixture.claimedAt !== 'string' ||
            !selectedReadback?.entry.dequeueAudit.startTs
        ) {
            throw new Error('Fixture omitted its actual persisted UTC timing facts');
        }
        expect([
            Temporal.Instant.from(fixture.injectedDueAt).toString(),
            Temporal.Instant.from(fixture.claimedAt).toString()
        ]).toEqual([
            selectedReadback.selectedDueTs.toString(),
            selectedReadback.entry.dequeueAudit.startTs.toString()
        ]);
    });
});
