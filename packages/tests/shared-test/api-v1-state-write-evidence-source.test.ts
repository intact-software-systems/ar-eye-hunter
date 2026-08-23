import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createAdminPruneCommand } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import {
    ADMIN_APP_INBOX_TOPIC,
    toAdminPruneContextId,
    toAdminPruneJobId
} from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-inbox-identity.ts';
import { toAdminPruneOutbox } from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import { toStrictAppInboxQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

import type { ApiV1StateWriteEvidenceSqlParameter } from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-contracts.ts';
import {
    collectApiV1StateWriteEvidence,
    readPGliteStateWriteEvidenceSnapshot,
    readPostgresStateWriteEvidenceSource,
    requestPGliteStateWriteEvidenceSnapshot,
    resolveApiV1StateWriteEvidenceSource,
    runBoundedPGliteReaderCommand,
    selectApiV1StateWriteEvidenceSource,
    toStateWriteEvidenceSql
} from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-source.ts';
import { collectApiV1StateWriteEvidenceFromSql } from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-sql.ts';

async function createSnapshotRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'pglite-evidence-request-'));
    await Promise.all(
        ['requests', 'responses', 'snapshots'].map(
            async (directory) => await mkdir(path.join(root, directory), { mode: 0o700 })
        )
    );
    return root;
}

async function waitForSnapshotRequest(root: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const [requestName] = (await readdir(path.join(root, 'requests'))).filter((name) => name.endsWith('.json'));
        if (requestName) {
            return requestName;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Expected PGlite snapshot request.');
}

describe('API-v1 PGlite state-write evidence source', () => {
    it('selects an active PGlite owner-process snapshot publisher', () => {
        expect(
            resolveApiV1StateWriteEvidenceSource({
                RALLAR_SQL_BACKEND: 'pglite-memory',
                RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR: '/tmp/api-v1-black-box/snapshots'
            })
        ).toEqual({ kind: 'pglite', snapshotDir: '/tmp/api-v1-black-box/snapshots' });
    });

    it('uses an explicit PostgreSQL URL without consulting a PGlite environment', () => {
        expect(
            selectApiV1StateWriteEvidenceSource('postgres://explicit.example/evidence', {
                RALLAR_SQL_BACKEND: 'pglite-memory',
                RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR: '/private/pglite-control'
            })
        ).toEqual({ kind: 'postgres', databaseUrl: 'postgres://explicit.example/evidence' });
        expect(
            selectApiV1StateWriteEvidenceSource(undefined, {
                RALLAR_SQL_BACKEND: 'postgres',
                DATABASE_URL: 'postgres://default.example/evidence'
            })
        ).toEqual({ kind: 'postgres', databaseUrl: 'postgres://default.example/evidence' });
    });

    it('closes an explicit PostgreSQL evidence client after its reader completes', async () => {
        const events: string[] = [];
        const sql = Object.assign(() => Promise.resolve([]), {
            end: async (input: { timeout: number; }) => {
                events.push(`end:${input.timeout}`);
            }
        });
        const value = await readPostgresStateWriteEvidenceSource(
            { kind: 'postgres', databaseUrl: 'postgres://explicit.example/evidence' },
            async (opened) => {
                expect(opened).toBe(sql);
                events.push('read');
                return 'evidence';
            },
            (databaseUrl, options) => {
                expect(databaseUrl).toBe('postgres://explicit.example/evidence');
                expect(options).toEqual({ max: 1 });
                events.push('open');
                return sql as never;
            }
        );
        expect(value).toBe('evidence');
        expect(events).toEqual(['open', 'read', 'end:5']);
    });

    it('delegates transaction queries without replacing the PostgreSQL begin owner', async () => {
        const rootQueries: string[] = [];
        const transactionQueries: string[] = [];
        const transaction = vi.fn(async (strings: TemplateStringsArray) => {
            transactionQueries.push(strings.join('?'));
            return [];
        });
        const begin = vi.fn(
            async (write: (query: typeof transaction) => Promise<void>) => await write(transaction)
        );
        const postgresSql = Object.assign(
            vi.fn(async (strings: TemplateStringsArray) => {
                rootQueries.push(strings.join('?'));
                return [];
            }),
            { begin }
        );

        const evidenceSql = toStateWriteEvidenceSql(postgresSql as never);
        expect(evidenceSql).not.toBe(postgresSql);
        await evidenceSql.begin(async (query) => {
            expect(query).not.toBe(transaction);
            await query`select ${'transaction-value'}`;
        });

        expect(begin).toHaveBeenCalledOnce();
        expect(rootQueries).toEqual([]);
        expect(transactionQueries).toEqual(['select ?']);
    });

    it('keeps raw JSON evidence inputs untrusted until the SQL validator runs', async () => {
        const rawInput: unknown = JSON.parse('{"match":""}');
        const sql = Object.assign(vi.fn(), { begin: vi.fn() });

        const collectInput: Parameters<typeof collectApiV1StateWriteEvidence>[0] = rawInput;
        const snapshotInput: Parameters<typeof readPGliteStateWriteEvidenceSnapshot>[1] = rawInput;

        await expect(collectApiV1StateWriteEvidenceFromSql(rawInput, sql as never)).rejects.toThrow(
            'stateWriteEvidence.match must be a non-empty string.'
        );
        expect(sql).not.toHaveBeenCalled();
        expect(collectInput).toBe(rawInput);
        expect(snapshotInput).toBe(rawInput);
    });

    it('links public admin request identity to its scoped page-work identity', async () => {
        const requestId = 'admin-evidence-request-0001';
        const requestedBy = `admin-${'principal-'.repeat(10)}`;
        const appData = { namespace: `evidence-${'namespace-'.repeat(15)}`, storeName: null };
        const logicalContextId = toAdminPruneContextId(requestedBy, appData);
        const physicalKey = toStrictAppInboxQueueKey({
            resourceId: requestId,
            topicId: ADMIN_APP_INBOX_TOPIC,
            contextId: logicalContextId
        });
        const jobId = await toAdminPruneJobId(physicalKey);
        const command = await createAdminPruneCommand({
            jobId,
            requestedBy,
            requestedSessionId: 'session-1',
            capturedAtEpochMs: 1_700_000_000_000,
            expireAtEpochMs: 1_700_000_060_000,
            dryRun: false,
            categories: ['app-data'],
            appData,
            pageSize: 100
        });
        const enqueue = {
            type: 'ADMIN_PRUNE_EXPIRED',
            topicId: physicalKey.topicId,
            resourceId: physicalKey.resourceId,
            contextId: physicalKey.contextId,
            senderId: command.requestedSessionId,
            data: command
        };
        const toInboxResource = (overrides: Partial<typeof enqueue> = {}) =>
            JSON.stringify({
                payload: {
                    typeId: 'ADMIN_PRUNE_EXPIRED',
                    resource: JSON.stringify({ ...enqueue, ...overrides })
                }
            });
        const inbox = {
            ri_row_id: 1,
            ri_resource_id: physicalKey.resourceId,
            ri_topic_id: physicalKey.topicId,
            fk_ext_bank_id: physicalKey.contextId,
            ri_resource: toInboxResource(),
            ri_status: 'COMPLETED',
            ri_attempts: 1,
            start_ts: null,
            end_ts: null,
            next_ts: null,
            result_status: 'COMPLETED',
            result_resource: JSON.stringify({
                generatedAtEpochMs: command.capturedAtEpochMs,
                serverId: 'server-1',
                warnings: [],
                operation: 'maintenance.prune-expired',
                status: 'queued',
                changed: false,
                jobId,
                results: [{
                    category: 'app-data',
                    expiredRows: 0,
                    deletedRows: 0,
                    dryRun: false
                }]
            })
        };
        const page = toAdminPruneOutbox({
            kind: 'page',
            jobId,
            category: 'app-data',
            requestedBy: command.requestedBy,
            requestedSessionId: command.requestedSessionId,
            capturedAtEpochMs: command.capturedAtEpochMs,
            expireAtEpochMs: command.expireAtEpochMs,
            pageSize: command.pageSize,
            afterCursor: null,
            pageIndex: 0,
            appData: command.appData
        }, 'server-1');
        const sql = Object.assign(
            vi.fn(async (parts: TemplateStringsArray, ...values: ApiV1StateWriteEvidenceSqlParameter[]) => {
                const query = parts.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
                if (query.includes('from resource_inbox i')) {
                    return [inbox];
                }
                if (query.includes('ri_type_id in (\'app_outbox\', \'ws_outbox\')')) {
                    return values[0] === jobId
                        ? [{
                            ri_resource_id: page.key.resourceId,
                            ri_topic_id: page.key.topicId,
                            fk_ext_bank_id: page.key.contextId,
                            ri_type_id: page.typeId,
                            ri_status: page.status,
                            ri_resource: page.resource
                        }]
                        : [];
                }
                return [];
            }),
            { begin: vi.fn() }
        );

        const evidence = await collectApiV1StateWriteEvidenceFromSql({
            match: requestId,
            commandTypes: ['ADMIN_PRUNE_EXPIRED'],
            expectedEffectsByCommandType: { ADMIN_PRUNE_EXPIRED: ['admin-prune-page'] }
        }, sql as never);

        expect(evidence).toMatchObject({
            matchedAppInboxCount: 1,
            atomicCompletionFailures: 0,
            resourceOutboxCount: 1,
            resourceOutbox: [{ commandId: jobId, effectKind: 'admin-prune-page' }]
        });

        for (
            const malformedEnqueue of [
                { topicId: `${physicalKey.topicId}:wrong` },
                { resourceId: `${physicalKey.resourceId}:wrong` },
                { contextId: `${physicalKey.contextId}:wrong` },
                { senderId: `${command.requestedSessionId}:wrong` }
            ]
        ) {
            inbox.ri_resource = toInboxResource(malformedEnqueue);
            await expect(collectApiV1StateWriteEvidenceFromSql({
                match: requestId,
                commandTypes: ['ADMIN_PRUNE_EXPIRED']
            }, sql as never)).resolves.toMatchObject({
                atomicCompletionFailures: 1,
                statusResultFailures: 1,
                appInbox: [{ durableResultValid: false }]
            });
        }
        inbox.ri_resource = toInboxResource();

        inbox.fk_ext_bank_id = toStrictAppInboxQueueKey({
            resourceId: requestId,
            topicId: ADMIN_APP_INBOX_TOPIC,
            contextId: toAdminPruneContextId('another-admin', appData)
        }).contextId;
        await expect(collectApiV1StateWriteEvidenceFromSql({
            match: requestId,
            commandTypes: ['ADMIN_PRUNE_EXPIRED']
        }, sql as never)).resolves.toMatchObject({
            atomicCompletionFailures: 1,
            statusResultFailures: 1,
            appInbox: [{ durableResultValid: false }]
        });

        const arbitraryJobId = `admin-prune:${'f'.repeat(64)}`;
        const arbitraryJobCommand = await createAdminPruneCommand({
            jobId: arbitraryJobId,
            requestedBy: command.requestedBy,
            requestedSessionId: command.requestedSessionId,
            capturedAtEpochMs: command.capturedAtEpochMs,
            expireAtEpochMs: command.expireAtEpochMs,
            dryRun: command.dryRun,
            categories: command.categories,
            appData: command.appData,
            pageSize: command.pageSize
        });
        inbox.fk_ext_bank_id = physicalKey.contextId;
        inbox.ri_resource = toInboxResource({ data: arbitraryJobCommand });
        inbox.result_resource = JSON.stringify({
            ...JSON.parse(inbox.result_resource),
            jobId: arbitraryJobId
        });
        await expect(collectApiV1StateWriteEvidenceFromSql({
            match: requestId,
            commandTypes: ['ADMIN_PRUNE_EXPIRED']
        }, sql as never)).resolves.toMatchObject({
            atomicCompletionFailures: 1,
            statusResultFailures: 1,
            appInbox: [{ durableResultValid: false }]
        });
    });

    it('retains numeric-string minimum and string commandTypes behavior', async () => {
        const row = {
            ri_row_id: 1,
            ri_resource_id: 'command-1',
            ri_topic_id: 'app-inbox',
            fk_ext_bank_id: 'scope',
            ri_resource: JSON.stringify({ payload: { typeId: 'GROUP_UPDATE' } }),
            ri_status: 'COMPLETED',
            ri_attempts: 1,
            start_ts: null,
            end_ts: null,
            next_ts: null,
            result_status: 'COMPLETED',
            result_resource: '{}'
        };
        const sql = Object.assign(
            vi.fn(async () => [row]),
            { begin: vi.fn() }
        );
        const rawInput = JSON.parse(
            '{"match":"scope","minimumMatchedRows":"2","commandTypes":"GROUP_UPDATE"}'
        );

        await expect(collectApiV1StateWriteEvidenceFromSql(rawInput, sql as never)).rejects.toThrow(
            'Expected at least 2 matching AppInbox rows; found 1.'
        );
        expect(sql).toHaveBeenCalledOnce();
    });

    it('acquires the PGlite snapshot before validating its raw evidence input', async () => {
        const root = await createSnapshotRoot();
        try {
            const pending = readPGliteStateWriteEvidenceSnapshot(
                { kind: 'pglite', snapshotDir: root },
                JSON.parse('{"match":""}')
            );
            const requestName = await waitForSnapshotRequest(root);
            const request = JSON.parse(readFileSync(path.join(root, 'requests', requestName), 'utf8'));
            await writeFile(
                path.join(root, 'responses', `${request.nonce}.json`),
                JSON.stringify({
                    ...request,
                    publishedAtEpochMs: request.requestedAtEpochMs + 1,
                    failure: 'snapshot unavailable'
                }),
                { mode: 0o600 }
            );

            await expect(pending).rejects.toThrow(
                'PGlite snapshot publisher failed: snapshot unavailable'
            );
        }
        finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    it('requires the exact nonce archive and removes every artifact on rejection', async () => {
        const root = await createSnapshotRoot();
        try {
            const pending = requestPGliteStateWriteEvidenceSnapshot(root);
            const requestName = await waitForSnapshotRequest(root);
            const request = JSON.parse(readFileSync(path.join(root, 'requests', requestName), 'utf8'));
            const unexpectedArchive = `${request.nonce}-wrong.tar`;
            await writeFile(path.join(root, 'snapshots', unexpectedArchive), 'snapshot', { mode: 0o600 });
            await writeFile(
                path.join(root, 'responses', `${request.nonce}.json`),
                JSON.stringify({
                    ...request,
                    publishedAtEpochMs: request.requestedAtEpochMs + 1,
                    snapshotFile: unexpectedArchive
                }),
                { mode: 0o600 }
            );

            await expect(pending).rejects.toThrow(/exact nonce archive/i);
            await expect(readdir(path.join(root, 'requests'))).resolves.toEqual([]);
            await expect(readdir(path.join(root, 'responses'))).resolves.toEqual([]);
            await expect(readdir(path.join(root, 'snapshots'))).resolves.toEqual([]);
        }
        finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    it('creates the request with private permissions and removes request response and archive after success', async () => {
        const root = await createSnapshotRoot();
        try {
            const pending = requestPGliteStateWriteEvidenceSnapshot(root);
            const requestName = await waitForSnapshotRequest(root);
            const request = JSON.parse(readFileSync(path.join(root, 'requests', requestName), 'utf8'));
            expect((await stat(path.join(root, 'requests', requestName))).mode & 0o777).toBe(0o600);
            const snapshotName = `${request.nonce}.tar`;
            await writeFile(path.join(root, 'snapshots', snapshotName), 'snapshot', { mode: 0o600 });
            await writeFile(
                path.join(root, 'responses', `${request.nonce}.json`),
                JSON.stringify({
                    ...request,
                    publishedAtEpochMs: request.requestedAtEpochMs + 1,
                    snapshotFile: snapshotName
                }),
                { mode: 0o600 }
            );

            const snapshot = await pending;
            await snapshot.cleanup();
            await expect(readdir(path.join(root, 'requests'))).resolves.toEqual([]);
            await expect(readdir(path.join(root, 'responses'))).resolves.toEqual([]);
            await expect(readdir(path.join(root, 'snapshots'))).resolves.toEqual([]);
        }
        finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    it('publishes its cancellation marker independently and leaves no marker temporary file', async () => {
        const root = await createSnapshotRoot();
        try {
            let clock = 0;
            await expect(
                requestPGliteStateWriteEvidenceSnapshot(root, {
                    timeoutMs: 0,
                    now: () => {
                        clock += 1;
                        return clock;
                    }
                })
            ).rejects.toThrow(/timed out/i);
            const cancellationNames = await readdir(path.join(root, 'cancellations'));
            expect(cancellationNames).toHaveLength(1);
            expect(cancellationNames[0]).toMatch(/^[a-f0-9]+\.json$/u);
            await expect(readdir(path.join(root, 'requests'))).resolves.toEqual([]);
            await expect(readdir(path.join(root, 'responses'))).resolves.toEqual([]);
            await expect(readdir(path.join(root, 'snapshots'))).resolves.toEqual([]);
        }
        finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    for (
        const scenario of [
            {
                name: 'marker failure with successful cleanup',
                markerError: new Error('marker write failed'),
                cleanupError: undefined,
                expectedEvents: ['marker', 'cleanup'],
                expectedErrors: [
                    'Timed out waiting 0ms for a PGlite evidence snapshot.',
                    'marker write failed'
                ]
            },
            {
                name: 'cleanup failure with successful marker',
                markerError: undefined,
                cleanupError: new Error('artifact cleanup failed'),
                expectedEvents: ['marker', 'cleanup'],
                expectedErrors: [
                    'Timed out waiting 0ms for a PGlite evidence snapshot.',
                    'artifact cleanup failed'
                ]
            },
            {
                name: 'marker and cleanup failures',
                markerError: new Error('marker write failed'),
                cleanupError: new Error('artifact cleanup failed'),
                expectedEvents: ['marker', 'cleanup'],
                expectedErrors: [
                    'Timed out waiting 0ms for a PGlite evidence snapshot.',
                    'marker write failed',
                    'artifact cleanup failed'
                ]
            }
        ] as const
    ) {
        it(`surfaces ${scenario.name} after attempting both rejection operations`, async () => {
            const root = await createSnapshotRoot();
            const events: string[] = [];
            let clock = 0;
            try {
                await requestPGliteStateWriteEvidenceSnapshot(root, {
                    timeoutMs: 0,
                    now: () => {
                        clock += 1;
                        return clock;
                    },
                    rejectionOperations: {
                        publishCancellation: async () => {
                            events.push('marker');
                            if (scenario.markerError) {
                                throw scenario.markerError;
                            }
                        },
                        cleanupArtifacts: async () => {
                            events.push('cleanup');
                            if (scenario.cleanupError) {
                                throw scenario.cleanupError;
                            }
                        }
                    }
                });
                throw new Error('Expected snapshot request rejection.');
            }
            catch (error) {
                expect(error).toBeInstanceOf(AggregateError);
                const aggregate = error as AggregateError;
                expect(aggregate.errors.map((item) => (item as Error).message)).toEqual(
                    scenario.expectedErrors
                );
            }
            finally {
                await rm(root, { force: true, recursive: true });
            }
            expect(events).toEqual(scenario.expectedEvents);
        });
    }

    it('kills a timed-out reader and rejects only after its close event', async () => {
        let closed = false;
        const pending = runBoundedPGliteReaderCommand(
            process.execPath,
            ['-e', 'setInterval(() => undefined, 1000)'],
            {
                timeoutMs: 20,
                maxOutputBytes: 1_000,
                afterClose: () => {
                    closed = true;
                }
            }
        );
        await expect(pending).rejects.toThrow(/timed out/i);
        expect(closed).toBe(true);
    });

    it('kills a reader that exceeds the bounded output budget', async () => {
        await expect(
            runBoundedPGliteReaderCommand(
                process.execPath,
                ['-e', 'process.stdout.write(\'x\'.repeat(4096)); setInterval(() => undefined, 1000)'],
                { timeoutMs: 1_000, maxOutputBytes: 64 }
            )
        ).rejects.toThrow(/exceeded 64 output bytes/i);
    });

    it('observes reader close before rejecting a nonzero exit', async () => {
        const events: string[] = [];
        const pending = runBoundedPGliteReaderCommand(
            process.execPath,
            ['-e', 'process.stderr.write(\'reader failed\'); process.exit(2)'],
            {
                timeoutMs: 1_000,
                maxOutputBytes: 1_000,
                afterClose: () => {
                    events.push('close');
                }
            }
        );
        await expect(pending).rejects.toThrow(/exited 2/i);
        expect(events).toEqual(['close']);
    });
});
