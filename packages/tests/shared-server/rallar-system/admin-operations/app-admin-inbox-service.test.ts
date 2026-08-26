import { describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ADMIN_PRUNE_EXPIRED_CATEGORIES, type AdminPruneExpiredCategory, type AdminPruneExpiredRequest } from '@shared/api/admin-operations-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarCrdtJsonValue } from '@shared/crdt/mod.ts';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createAdminPruneCommand,
    decodeAdminPruneCommand,
    type AdminPruneCommand
} from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { type AdminPruneEnqueueResult } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-inbox-codec.ts';
import { createAdminPruneIdempotencyIdentity } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-inbox-identity.ts';
import { AppAdminInboxService, type AdminPruneAuthority } from '@shared-server/rallar-system/admin-operations/inbox/app-admin-inbox-service.ts';
import { decodeAdminPruneWork } from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import {
    ADMIN_PRUNE_AGGREGATE_TOPIC,
    decodeAdminPruneAggregate,
    toAdminPruneAggregateKey
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-progress.ts';
import { AppInboxIdempotencyConflictError, AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { createAppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import { createResilience, TestResourceInbox, TestResourceInboxResults, waitForQueueEntry } from '../group-state/inbox/group-state-inbox-test-runtime.ts';

const INITIAL_TIME_EPOCH_MS = 1_800_000_000_000;
const RETRY_EXPIRY_OFFSET_MS = 900_000;

interface CreateAdminInboxHarnessOptions {
    readonly allowCurrentAuthority?: boolean;
    readonly conflictFirstTransaction?: boolean;
    readonly failOutboxWrite?: boolean;
    readonly retryExpiryOffsetMs?: number;
    readonly waitForResult?: boolean;
}

interface AdminPruneConflictCase {
    readonly name: string;
    readonly session: AuthSession;
    readonly request: AdminPruneRequestFixture;
}

interface AdminPruneUnavailableCase {
    readonly name: string;
    readonly options: CreateAdminInboxHarnessOptions;
    readonly request: AdminPruneRequestFixture;
    readonly expectedCode: string;
}

interface MalformedAdminPruneResultCase {
    readonly name: string;
    readonly createResult: (result: AdminPruneEnqueueResult) => RallarCrdtJsonValue;
}

interface AdminPruneRequestFixture extends AdminPruneExpiredRequest {
    readonly requestId: string;
}

interface AdminPruneInput {
    readonly requestId: string;
    readonly request: AdminPruneExpiredRequest;
}

describe('AppAdminInboxService initial prune command', () => {
    it('normalizes defaults and captures volatile command facts once before enqueue', async () => {
        const harness = createAdminInboxHarness();
        const pending = harness.service.pruneExpired({
            adminSession: createAdminSession('admin', 'admin-session'),
            requestId: 'default-prune-request',
            request: {}
        });

        await waitForQueueEntry(harness.queue);
        const command = await readOnlyCommand(harness.queue);

        expect(command).toMatchObject({
            jobId: expect.any(String),
            requestedBy: 'admin',
            requestedSessionId: 'admin-session',
            capturedAtEpochMs: INITIAL_TIME_EPOCH_MS,
            expireAtEpochMs: INITIAL_TIME_EPOCH_MS + RETRY_EXPIRY_OFFSET_MS,
            dryRun: true,
            categories: defaultAdminPruneCategories(),
            appData: null,
            pageSize: 25
        });
        expect(command.jobId.length).toBeGreaterThan(0);
        expect(harness.events.slice(0, 4)).toEqual([
            'semantic-identity-completed',
            'phase:semantic-identity',
            'now-callback',
            'retry-expiry-callback'
        ]);
        expect(harness.events.indexOf('semantic-identity-completed')).toBeLessThan(
            harness.events.indexOf('now-callback')
        );
        expect(harness.events.indexOf('semantic-identity-completed')).toBeLessThan(
            harness.events.indexOf('retry-expiry-callback')
        );
        expect(harness.identityInputs()).toEqual([{
            requestId: 'default-prune-request',
            requestedBy: 'admin',
            requestedSessionId: 'admin-session',
            categories: defaultAdminPruneCategories(),
            appData: null,
            dryRun: true
        }]);
        expect(harness.timingEvents).toContainEqual(
            expect.objectContaining({
                component: 'admin-prune-inbox',
                operation: 'semantic-identity',
                principalId: 'admin',
                sessionId: 'admin-session',
                details: expect.objectContaining({ semanticHash: expect.stringMatching(/^sha256:/u) })
            })
        );
        expect(harness.retryExpiryInputs()).toEqual([INITIAL_TIME_EPOCH_MS]);
        expect(harness.readWorkCounts()).toEqual({
            now: 1,
            expiry: 1,
            authority: 0,
            count: 0,
            transaction: 0,
            wake: 0
        });

        await dequeueInitialCommand(harness);
        await expect(pending).resolves.toMatchObject({ right: { status: 'dry-run' } });
        expect(harness.readWorkCounts().wake).toBe(1);
    });

    it('rejects app-data without a namespace before volatile or mutation work', async () => {
        const harness = createAdminInboxHarness();

        await expect(
            harness.service.pruneExpired({
                adminSession: createAdminSession('admin', 'admin-session'),
                requestId: 'invalid-app-data-request',
                request: { categories: ['app-data'] }
            })
        ).rejects.toThrow('appData.namespace is required');

        expect(harness.readWorkCounts()).toEqual({
            now: 0,
            expiry: 0,
            authority: 0,
            count: 0,
            transaction: 0,
            wake: 0
        });
    });

    it('reuses a same-client same-session request without recapturing facts', async () => {
        const harness = createAdminInboxHarness();
        const request = {
            requestId: 'matching-replay',
            categories: ['runtime-state'] as const,
            dryRun: true
        };

        const first = await completePrune(
            harness,
            createAdminSession('admin', 'admin-session'),
            request
        );
        const firstCommand = await readOnlyCommand(harness.queue, 'matching-replay', 'admin');
        harness.advanceTime(60_000);
        const beforeReplay = harness.readWorkCounts();

        await expect(
            harness.service.pruneExpired({
                adminSession: createAdminSession('admin', 'admin-session'),
                ...toPruneInput(request)
            })
        ).resolves.toEqual(first);

        expect(await readOnlyCommand(harness.queue, 'matching-replay', 'admin')).toEqual(firstCommand);
        expect(harness.readWorkCounts()).toEqual(beforeReplay);
    });

    it('reuses a same-client request after credential-session renewal', async () => {
        const harness = createAdminInboxHarness();
        const request = {
            requestId: 'renewed-session-replay',
            categories: ['runtime-state'] as const,
            dryRun: true
        };
        const first = await completePrune(
            harness,
            createAdminSession('admin', 'first-session'),
            request
        );
        const beforeReplay = harness.readWorkCounts();

        await expect(
            harness.service.pruneExpired({
                adminSession: createAdminSession('admin', 'renewed-session'),
                ...toPruneInput(request)
            })
        ).resolves.toEqual(first);

        expect(harness.readWorkCounts()).toEqual(beforeReplay);
    });

    it('materializes volatile command facts only for the equal concurrent winner', async () => {
        const harness = createAdminInboxHarness();
        const request = {
            requestId: 'equal-concurrent-prune',
            categories: ['runtime-state'] as const,
            dryRun: true
        };
        const first = harness.service.pruneExpired({
            adminSession: createAdminSession('admin', 'admin-session'),
            ...toPruneInput(request)
        });
        const contender = harness.service.pruneExpired({
            adminSession: createAdminSession('admin', 'admin-session'),
            ...toPruneInput(request)
        });

        await waitForQueueEntry(harness.queue);
        expect(harness.readWorkCounts()).toMatchObject({ expiry: 1, now: 1 });
        await dequeueInitialCommand(harness);
        await expect(Promise.all([first, contender])).resolves.toHaveLength(2);

        expect(harness.readWorkCounts()).toMatchObject({ expiry: 1, count: 1 });
        expect(harness.transactionCount()).toBe(1);
    });

    it('preserves first-occurrence category order for fresh command and result facts', async () => {
        const harness = createAdminInboxHarness();
        const result = await completePrune(harness, createAdminSession('admin', 'admin-session'), {
            requestId: 'first-occurrence-order',
            categories: ['resource-inbox-results', 'runtime-state', 'resource-inbox-results'],
            dryRun: true
        });

        const command = await readOnlyCommand(harness.queue, 'first-occurrence-order', 'admin');
        expect(command.categories).toEqual(['resource-inbox-results', 'runtime-state']);
        expect(readAdminPruneResultCategories(result.right)).toEqual([
            'resource-inbox-results',
            'runtime-state'
        ]);
    });

    it('replays the first category order for the same reordered set', async () => {
        const harness = createAdminInboxHarness();
        const requestId = 'first-order-replay';
        await completePrune(harness, createAdminSession('admin', 'admin-session'), {
            requestId,
            categories: ['resource-inbox-results', 'runtime-state'],
            dryRun: true
        });
        const beforeReplay = harness.readWorkCounts();

        const replay = await harness.service.pruneExpired({
            adminSession: createAdminSession('admin', 'admin-session'),
            requestId,
            request: {
                categories: ['runtime-state', 'resource-inbox-results'],
                dryRun: true
            }
        });

        expect(readAdminPruneResultCategories(replay.right)).toEqual([
            'resource-inbox-results',
            'runtime-state'
        ]);
        expect(harness.readWorkCounts()).toEqual(beforeReplay);
    });

    it.each<AdminPruneConflictCase>([
        {
            name: 'categories',
            session: createAdminSession('admin', 'admin-session'),
            request: { requestId: 'same-client-conflict', categories: ['resource-inbox'], dryRun: true }
        },
        {
            name: 'dry-run semantics',
            session: createAdminSession('admin', 'admin-session'),
            request: { requestId: 'same-client-conflict', categories: ['runtime-state'], dryRun: false }
        }
    ])(
        'rejects changed $name under an existing same-client request ID without new work',
        rejectsChangedAdminPruneRequest
    );

    it('uses a distinct key for another client with the same request ID', async () => {
        const harness = createAdminInboxHarness();
        const request = {
            requestId: 'client-scoped-request-id',
            categories: ['runtime-state'] as const,
            dryRun: true
        };

        await completePrune(harness, createAdminSession('admin-a', 'admin-a-session'), request);
        await completePrune(harness, createAdminSession('admin-b', 'admin-b-session'), request);

        expect(await listCommands(harness.queue, 'client-scoped-request-id')).toMatchObject([
            { requestedBy: 'admin-a', requestedSessionId: 'admin-a-session' },
            { requestedBy: 'admin-b', requestedSessionId: 'admin-b-session' }
        ]);
        expect(harness.readWorkCounts().count).toBe(2);
    });

    it(
        'isolates non-dry-run page and aggregate identities for two admins ' + 'sharing a request ID',
        async () => {
            const harness = createAdminInboxHarness({ waitForResult: false });
            const request = {
                requestId: 'cross-admin-page-isolation',
                categories: ['runtime-state'] as const,
                dryRun: false
            };
            const first = harness.service.pruneExpired({
                adminSession: createAdminSession('admin-a', 'admin-a-session'),
                ...toPruneInput(request)
            });
            const second = harness.service.pruneExpired({
                adminSession: createAdminSession('admin-b', 'admin-b-session'),
                ...toPruneInput(request)
            });

            await waitForQueueEntry(harness.queue);
            await dequeueInitialCommand(harness);
            await Promise.all([first, second]);

            const commands = await listCommands(harness.queue, request.requestId);
            expect(commands).toHaveLength(2);
            expect(new Set(commands.map((command) => command.jobId)).size).toBe(2);
            expect(harness.database.outboxEntries.size).toBe(2);
            expect(
                new Set([...harness.database.outboxEntries.values()].map((entry) => entry.key.contextId))
                    .size
            ).toBe(2);
        }
    );

    it('isolates jobs for one admin sharing a request ID across app-data targets', async () => {
        const harness = createAdminInboxHarness({ waitForResult: false });
        const adminSession = createAdminSession('admin', 'admin-session');
        const requestId = 'cross-target-page-isolation';
        const first = harness.service.pruneExpired({
            adminSession,
            requestId,
            request: {
                categories: ['app-data'],
                appData: { namespace: 'tenant-a', storeName: 'cache' },
                dryRun: false
            }
        });
        const second = harness.service.pruneExpired({
            adminSession,
            requestId,
            request: {
                categories: ['app-data'],
                appData: { namespace: 'tenant-b', storeName: 'cache' },
                dryRun: false
            }
        });

        await waitForQueueEntry(harness.queue);
        await dequeueInitialCommand(harness);
        await Promise.all([first, second]);

        const commands = await listCommands(harness.queue, requestId);
        expect(commands).toHaveLength(2);
        expect(new Set(commands.map((command) => command.jobId)).size).toBe(2);
        expect(harness.database.outboxEntries.size).toBe(2);
        expect(
            new Set([...harness.database.outboxEntries.values()].map((entry) => entry.key.contextId))
                .size
        ).toBe(2);
    });

    it('puts app-data details only on the app-data page of a mixed-category command', async () => {
        const harness = createAdminInboxHarness({ waitForResult: false });
        const pending = harness.service.pruneExpired({
            adminSession: createAdminSession('admin', 'admin-session'),
            requestId: 'mixed-category-page-details',
            request: {
                categories: ['runtime-state', 'app-data'],
                appData: { namespace: 'tenant-a', storeName: 'cache' },
                dryRun: false
            }
        });

        await waitForQueueEntry(harness.queue);
        await dequeueInitialCommand(harness);
        await pending;

        const pages = [...harness.database.outboxEntries.values()]
            .map((entry) => decodeAdminPruneWork({ ...entry, status: EntityStatus.RESERVED }))
            .toSorted((left, right) => left.category.localeCompare(right.category));
        expect(pages.map((page) => ({ category: page.category, appData: page.appData }))).toEqual([
            {
                category: 'app-data',
                appData: { namespace: 'tenant-a', storeName: 'cache' }
            },
            { category: 'runtime-state', appData: null }
        ]);
    });

    it('bounds downstream identities for a maximum request ID and long scoped target', async () => {
        const harness = createAdminInboxHarness({ waitForResult: false });
        const requestId = 'r'.repeat(128);
        const pending = harness.service.pruneExpired({
            adminSession: createAdminSession(`admin-${'a'.repeat(96)}`, 'admin-session'),
            requestId,
            request: {
                categories: ['app-data'],
                appData: {
                    namespace: `namespace-${'n'.repeat(96)}`,
                    storeName: `store-${'s'.repeat(96)}`
                },
                dryRun: false
            }
        });

        await waitForQueueEntry(harness.queue);
        await dequeueInitialCommand(harness);
        await pending;

        const command = (await listCommands(harness.queue, requestId))[0];
        if (command === undefined) {
            throw new Error('Maximum-length prune command was not persisted');
        }
        expect(command.jobId.length).toBeLessThanOrEqual(128);
        expect(toAdminPruneAggregateKey(command.jobId).resourceId.length).toBeLessThanOrEqual(128);
        for (const entry of harness.database.outboxEntries.values()) {
            expect(entry.key.resourceId.length).toBeLessThanOrEqual(128);
            expect(entry.key.contextId.length).toBeLessThanOrEqual(128);
        }
    });

    it('runs dry-run reads and one commit without post-commit wake', async () => {
        const harness = createAdminInboxHarness();

        await completePrune(harness, createAdminSession('admin', 'admin-session'), {
            requestId: 'dry-run-phase-order',
            categories: ['runtime-state'],
            dryRun: true
        });

        expect(harness.events.filter((event) => event !== 'queue-wake')).toEqual([
            'semantic-identity-completed',
            'phase:semantic-identity',
            'now-callback',
            'retry-expiry-callback',
            'now-callback',
            'count:runtime-state',
            'current-authority',
            'phase:read',
            'phase:compute',
            'phase:validate',
            'transaction',
            'result-write',
            'now-callback',
            'commit-return'
        ]);
        expect(harness.events.filter((event) => event === 'queue-wake')).toHaveLength(1);
        expect(harness.database.outboxEntries.size).toBe(0);
    });

    it('commits aggregate and page work before waking downstream work', async () => {
        const harness = createAdminInboxHarness();

        await completePrune(harness, createAdminSession('admin', 'admin-session'), {
            requestId: 'durable-phase-order',
            categories: ['runtime-state', 'resource-inbox-results'],
            dryRun: false
        });

        expect(harness.events.filter((event) => event !== 'queue-wake')).toEqual([
            'semantic-identity-completed',
            'phase:semantic-identity',
            'now-callback',
            'retry-expiry-callback',
            'now-callback',
            'count:runtime-state',
            'count:resource-inbox-results',
            'current-authority',
            'phase:read',
            'phase:compute',
            'phase:validate',
            'transaction',
            'page-write',
            'page-write',
            'aggregate-write',
            'result-write',
            'now-callback',
            'commit-return'
        ]);
        expect(harness.events.filter((event) => event === 'queue-wake')).toHaveLength(2);
        expect(harness.events.lastIndexOf('queue-wake')).toBeGreaterThan(
            harness.events.indexOf('commit-return')
        );
        expect(harness.database.outboxEntries.size).toBe(2);
    });

    it('rolls back an outbox collision without loading a winner or waking', async () => {
        const harness = createAdminInboxHarness({ failOutboxWrite: true, waitForResult: false });

        await expect(
            harness.service.pruneExpired({
                adminSession: createAdminSession('admin', 'admin-session'),
                requestId: 'initial-outbox-collision',
                request: {
                    categories: ['runtime-state'],
                    dryRun: false
                }
            })
        ).resolves.toMatchObject({ left: { code: 'app-inbox-unavailable' } });
        await waitForQueueEntry(harness.queue);
        await dequeueInitialCommand(harness);

        expect(harness.database.outboxEntries.size).toBe(0);
        expect(harness.outboxWinnerLookups()).toBe(0);
        expect(harness.durableResultQueryLookups()).toBe(0);
        expect(harness.durableResultPortLookups()).toBe(0);
        expect(harness.readWorkCounts().wake).toBe(1);
    });

    it('restarts read and write after an optimistic transaction conflict', async () => {
        const harness = createAdminInboxHarness({ conflictFirstTransaction: true });

        await completePruneAttempts({
            harness,
            adminSession: createAdminSession('admin', 'admin-session'),
            request: {
                requestId: 'retry-full-phase-sequence',
                categories: ['runtime-state'],
                dryRun: true
            },
            dequeueAttempts: 2
        });

        expect(harness.readWorkCounts()).toMatchObject({
            authority: 2,
            count: 2,
            transaction: 2,
            wake: 1
        });
        expect(harness.events.filter((event) => event !== 'queue-wake')).toEqual([
            'semantic-identity-completed',
            'phase:semantic-identity',
            'now-callback',
            'retry-expiry-callback',
            'now-callback',
            'count:runtime-state',
            'current-authority',
            'phase:read',
            'phase:compute',
            'phase:validate',
            'transaction',
            'now-callback',
            'count:runtime-state',
            'current-authority',
            'phase:read',
            'phase:compute',
            'phase:validate',
            'transaction',
            'result-write',
            'now-callback',
            'commit-return'
        ]);
    });

    it.each<AdminPruneUnavailableCase>([
        {
            name: 'current authority denial',
            options: { allowCurrentAuthority: false },
            request: { requestId: 'denied-prune', categories: ['runtime-state'], dryRun: true },
            expectedCode: 'admin-prune-authority-denied'
        },
        {
            name: 'expired command',
            options: { retryExpiryOffsetMs: 1 },
            request: { requestId: 'expired-prune', categories: ['runtime-state'], dryRun: true },
            expectedCode: 'admin-prune-authority-denied'
        }
    ])(
        'classifies $name without durable mutation work',
        async ({ options, request, expectedCode }) => {
            const harness = createAdminInboxHarness(options);

            const pending = harness.service.pruneExpired({
                adminSession: createAdminSession('admin', 'admin-session'),
                ...toPruneInput(request)
            });
            await waitForQueueEntry(harness.queue);
            if (options.retryExpiryOffsetMs !== undefined) {
                harness.advanceTime(2);
            }
            await dequeueInitialCommand(harness);
            const result = await pending;

            expect(result.left).toMatchObject({ code: expectedCode });
            expect(harness.database.outboxEntries.size).toBe(0);
            expect(harness.readWorkCounts().wake).toBe(1);
        }
    );

    it('replays the exact durable current-authority failure without mutation work', async () => {
        const harness = createAdminInboxHarness({ allowCurrentAuthority: false });
        const request = {
            requestId: 'denied-prune-replay',
            categories: ['runtime-state'] as const,
            dryRun: true
        };
        const first = await completePrune(
            harness,
            createAdminSession('admin', 'first-session'),
            request
        );
        const beforeReplay = harness.readWorkCounts();

        const replay = await harness.service.pruneExpired({
            adminSession: createAdminSession('admin', 'renewed-session'),
            ...toPruneInput(request)
        });

        expect(replay).toEqual(first);
        expect(replay.left).toMatchObject({
            type: 'app-inbox-failure',
            code: 'admin-prune-authority-denied',
            status: 403
        });
        expect(harness.readWorkCounts()).toEqual(beforeReplay);
    });

    it.each<MalformedAdminPruneResultCase>([
        {
            name: 'an extra top-level field',
            createResult: (result) => ({ ...result, unexpected: true })
        },
        {
            name: 'an empty durable identity',
            createResult: (result) => ({ ...result, jobId: '' })
        },
        {
            name: 'duplicate categories',
            createResult: (result) => ({ ...result, results: [result.results[0]!, result.results[0]!] })
        },
        {
            name: 'more deleted rows than expired rows',
            createResult: (result) => ({
                ...result,
                changed: true,
                results: [{ ...result.results[0], deletedRows: result.results[0]!.expiredRows + 1 }]
            })
        },
        {
            name: 'an inconsistent changed flag',
            createResult: (result) => ({ ...result, changed: true })
        },
        {
            name: 'an inconsistent dry-run flag',
            createResult: (result) => ({
                ...result,
                results: result.results.map((categoryResult) => ({ ...categoryResult, dryRun: false }))
            })
        },
        {
            name: 'dry-run deletions',
            createResult: (result) => ({
                ...result,
                changed: true,
                results: [{ ...result.results[0], expiredRows: 1, deletedRows: 1 }]
            })
        },
        {
            name: 'another command job identity',
            createResult: (result) => ({ ...result, jobId: 'another-admin-prune-job' })
        },
        {
            name: 'another command generation time',
            createResult: (result) => ({
                ...result,
                generatedAtEpochMs: result.generatedAtEpochMs + 1
            })
        },
        {
            name: 'another command category',
            createResult: (result) => ({
                ...result,
                results: [{ ...result.results[0], category: 'resource-inbox' }]
            })
        },
        {
            name: 'another command execution status',
            createResult: (result) => ({
                ...result,
                status: 'queued',
                results: result.results.map((categoryResult) => ({ ...categoryResult, dryRun: false }))
            })
        },
        {
            name: 'no category results',
            createResult: (result) => ({ ...result, results: [] })
        }
    ])('rejects durable replay containing $name', async ({ createResult }) => {
        const harness = createAdminInboxHarness();
        const request = {
            requestId: 'malformed-durable-replay',
            categories: ['runtime-state'] as const,
            dryRun: true
        };
        const first = await completePrune(
            harness,
            createAdminSession('admin', 'admin-session'),
            request
        );
        if (first.right === undefined) {
            throw new Error('Expected successful admin prune result');
        }
        const key = (await harness.queue.getAllKeys()).find(
            (candidate) => candidate.resourceId === request.requestId
        );
        if (key === undefined) {
            throw new Error('Expected durable admin prune key');
        }
        const stored = await harness.results.findByKey(key);
        if (stored === undefined) {
            throw new Error('Expected durable admin prune result');
        }
        await harness.results.replace({
            ...stored,
            resource: JSON.stringify(createResult(first.right))
        });
        const beforeReplay = harness.readWorkCounts();

        const replay = await harness.service.pruneExpired({
            adminSession: createAdminSession('admin', 'renewed-session'),
            ...toPruneInput(request)
        });

        expect(replay.left).toMatchObject({
            type: 'app-inbox-failure',
            code: 'app-inbox-result-corrupt',
            status: 500,
            message: 'Persisted AppInbox result is corrupt'
        });
        expect(harness.readWorkCounts()).toEqual(beforeReplay);
    });

    it('rejects a completed aggregate replay whose identity differs from the stored command', async () => {
        const harness = createAdminInboxHarness({ waitForResult: false });
        const adminSession = createAdminSession('admin', 'admin-session');
        const request = {
            requestId: 'mismatched-completed-aggregate',
            categories: ['runtime-state'] as const,
            dryRun: false
        };
        const first = await completePrune(harness, adminSession, request);
        expect(first.left).toMatchObject({ code: 'app-inbox-unavailable' });

        const command = await readOnlyCommand(harness.queue, request.requestId);
        const aggregateKey = toAdminPruneAggregateKey(command.jobId);
        const storedAggregate = await harness.results.findByKey(aggregateKey);
        if (storedAggregate === undefined) {
            throw new Error('Expected pending admin prune aggregate');
        }
        const aggregate = decodeAdminPruneAggregate(JSON.parse(storedAggregate.resource));
        await harness.results.replace({
            ...storedAggregate,
            status: EntityStatus.COMPLETED,
            resource: JSON.stringify({
                ...aggregate,
                revision: 1,
                jobId: 'another-completed-admin-prune-job',
                status: 'completed',
                completedCategories: ['runtime-state']
            })
        });

        await expect(harness.service.pruneExpired({
            adminSession: createAdminSession('admin', 'renewed-session'),
            ...toPruneInput(request)
        })).rejects.toThrow('Admin prune aggregate differs from command');
    });

    it('accepts a completed aggregate whose page retries renewed its expiry', async () => {
        const harness = createAdminInboxHarness({ waitForResult: false });
        const adminSession = createAdminSession('admin', 'admin-session');
        const request = {
            requestId: 'renewed-completed-aggregate-expiry',
            categories: ['runtime-state'] as const,
            dryRun: false
        };
        const first = await completePrune(harness, adminSession, request);
        expect(first.left).toMatchObject({ code: 'app-inbox-unavailable' });

        const command = await readOnlyCommand(harness.queue, request.requestId);
        const aggregateKey = toAdminPruneAggregateKey(command.jobId);
        const storedAggregate = await harness.results.findByKey(aggregateKey);
        if (storedAggregate === undefined) {
            throw new Error('Expected pending admin prune aggregate');
        }
        const aggregate = decodeAdminPruneAggregate(JSON.parse(storedAggregate.resource));
        await harness.results.replace({
            ...storedAggregate,
            status: EntityStatus.COMPLETED,
            resource: JSON.stringify({
                ...aggregate,
                revision: 1,
                expireAtEpochMs: command.expireAtEpochMs + 60_000,
                status: 'completed',
                completedCategories: ['runtime-state']
            })
        });

        await expect(harness.service.pruneExpired({
            adminSession: createAdminSession('admin', 'renewed-session'),
            ...toPruneInput(request)
        })).resolves.toMatchObject({
            right: {
                status: 'completed',
                jobId: command.jobId,
                results: [{ category: 'runtime-state', dryRun: false }]
            }
        });
    });

    it('returns the existing unavailable failure when the initial result wait exhausts', async () => {
        const harness = createAdminInboxHarness({ waitForResult: false });

        await expect(
            harness.service.pruneExpired({
                adminSession: createAdminSession('admin', 'admin-session'),
                requestId: 'wait-exhaustion',
                request: { categories: ['runtime-state'], dryRun: true }
            })
        ).resolves.toMatchObject({ left: { code: 'app-inbox-unavailable' } });

        expect(harness.readWorkCounts()).toMatchObject({
            authority: 0,
            count: 0,
            transaction: 0
        });
    });
});

async function rejectsChangedAdminPruneRequest({
    session,
    request
}: AdminPruneConflictCase): Promise<void> {
    const harness = createAdminInboxHarness();
    await completePrune(harness, createAdminSession('admin', 'admin-session'), {
        requestId: 'same-client-conflict',
        categories: ['runtime-state'],
        dryRun: true
    });
    const beforeConflict = harness.readWorkCounts();
    const conflict = harness.service.pruneExpired({
        adminSession: session,
        ...toPruneInput(request)
    });
    await expect(conflict).rejects.toBeInstanceOf(AppInboxIdempotencyConflictError);
    await expect(conflict).rejects.toMatchObject({
        code: 'app-inbox-idempotency-conflict',
        status: 409
    });

    expect(harness.readWorkCounts()).toEqual(beforeConflict);
    expect(harness.identityInputs()).toHaveLength(2);
    const semanticHashes = readSemanticHashes(harness.timingEvents);
    expect(semanticHashes).toHaveLength(2);
    expect(semanticHashes[0]).toMatch(/^sha256:/u);
    expect(semanticHashes[1]).not.toBe(semanticHashes[0]);
}

function defaultAdminPruneCategories(): readonly AdminPruneExpiredCategory[] {
    return ADMIN_PRUNE_EXPIRED_CATEGORIES.filter(isNotAppDataCategory);
}

function toPruneInput(fixture: AdminPruneRequestFixture): AdminPruneInput {
    const { requestId, ...request } = fixture;
    return { requestId, request };
}

function isNotAppDataCategory(category: AdminPruneExpiredCategory): boolean {
    return category !== 'app-data';
}

function readAdminPruneResultCategories(
    result: AdminPruneEnqueueResult | undefined
): readonly AdminPruneExpiredCategory[] {
    return result?.results.map(readAdminPruneResultCategory) ?? [];
}

function readAdminPruneResultCategory(
    result: Readonly<{ category: AdminPruneExpiredCategory; }>
): AdminPruneExpiredCategory {
    return result.category;
}

interface AdminInboxHarness {
    readonly service: AppAdminInboxService;
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly reader: InboxQueueReader;
    readonly database: ReturnType<typeof createAppInboxTestDatabase>;
    readonly events: string[];
    readonly timingEvents: RallarTimingEvent[];
    advanceTime(milliseconds: number): void;
    durableResultPortLookups(): number;
    durableResultQueryLookups(): number;
    outboxWinnerLookups(): number;
    identityInputs(): readonly AdminPruneIdempotencyIdentityInput[];
    retryExpiryInputs(): readonly number[];
    readWorkCounts(): Readonly<{
        now: number;
        expiry: number;
        authority: number;
        count: number;
        transaction: number;
        wake: number;
    }>;
    transactionCount(): number;
}

function createAdminInboxHarness(options: CreateAdminInboxHarnessOptions = {}): AdminInboxHarness {
    const events: string[] = [];
    const timingEvents: RallarTimingEvent[] = [];
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    let currentTimeEpochMs = INITIAL_TIME_EPOCH_MS;
    let transactions = 0;
    let collisionWinnerLookups = 0;
    let resultPortLookups = 0;
    let resultQueryLookups = 0;
    let nowReads = 0;
    let authorityReads = 0;
    let expiredCounts = 0;
    let wakeRequests = 0;
    const retryExpiryInputValues: number[] = [];
    const idempotencyIdentityInputs: AdminPruneIdempotencyIdentityInput[] = [];
    const nowEpochMs = () => {
        nowReads += 1;
        events.push('now-callback');
        return currentTimeEpochMs;
    };
    const computeRetryExpiryAtEpochMs = (capturedAtEpochMs: number) => {
        retryExpiryInputValues.push(capturedAtEpochMs);
        events.push('retry-expiry-callback');
        return capturedAtEpochMs + (options.retryExpiryOffsetMs ?? RETRY_EXPIRY_OFFSET_MS);
    };
    const createAdminPruneIdentity = async (
        input: AdminPruneIdempotencyIdentityInput
    ): Promise<AdminPruneIdempotencyIdentity> => {
        idempotencyIdentityInputs.push(input);
        const identity = await createAdminPruneIdempotencyIdentity(input);
        events.push('semantic-identity-completed');
        return identity;
    };
    const readAuthority = async (): Promise<AdminPruneAuthority> => {
        authorityReads += 1;
        events.push('current-authority');
        return {
            allowed: options.allowCurrentAuthority ?? true,
            code: options.allowCurrentAuthority === false ? 'admin-prune-authority-denied' : 'allowed'
        };
    };
    const pruner = {
        countExpired: async (category: AdminPruneExpiredCategory) => {
            expiredCounts += 1;
            events.push(`count:${category}`);
            return category.length;
        }
    };
    const wakeQueueEngine = () => {
        wakeRequests += 1;
        events.push('queue-wake');
    };
    const resultRepository = {
        replace: async (entry: ResourceEntry) => {
            return await results.replace(entry);
        },
        findByKey: async (...arguments_: Parameters<TestResourceInboxResults['findByKey']>) => {
            resultPortLookups += 1;
            return await results.findByKey(...arguments_);
        }
    };
    const database = createAppInboxTestDatabase(queue, resultRepository, {
        shouldFailOutboxWrite: options.failOutboxWrite ? () => true : undefined,
        withTransaction: async (write) => {
            transactions += 1;
            events.push('transaction');
            if (options.conflictFirstTransaction && transactions === 1) {
                throw Object.assign(new Error('optimistic write conflict'), {
                    code: 'runtime-state-write-conflict',
                    status: 503
                });
            }
            return await write();
        },
        onStage: (stage) => {
            if (stage === 'transaction-commit-return') {
                events.push('commit-return');
            }
        }
    });
    const observedDatabase = createObservedDatabase(database, events, {
        recordOutboxWinnerLookup: () => {
            collisionWinnerLookups += 1;
        },
        recordDurableResultLookup: () => {
            resultQueryLookups += 1;
        }
    });
    const service = new AppAdminInboxService(
        {
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: resultRepository,
            database: observedDatabase,
            pruner,
            readAuthority,
            wakeQueueEngine,
            computeRetryExpiryAtEpochMs,
            createAdminPruneIdempotencyIdentity: createAdminPruneIdentity
        },
        {
            serviceId: 'admin-inbox-test-server',
            pageSize: 25,
            timing: (event) => recordAdminPrunePhase(events, timingEvents, event),
            appInbox: {
                nowEpochMs,
                waitMaxElapsedMsecs: options.waitForResult === false ? 0 : 1_000,
                waitRetryIntervalMsecs: 0,
                waitMaxRetryIntervalMsecs: 0,
                waitJitterRatio: 0
            }
        }
    );
    return {
        service,
        queue,
        results,
        reader,
        database,
        events,
        timingEvents,
        advanceTime: (milliseconds) => {
            currentTimeEpochMs += milliseconds;
        },
        durableResultPortLookups: () => resultPortLookups,
        durableResultQueryLookups: () => resultQueryLookups,
        outboxWinnerLookups: () => collisionWinnerLookups,
        identityInputs: () => idempotencyIdentityInputs,
        retryExpiryInputs: () => retryExpiryInputValues,
        readWorkCounts: () => ({
            now: nowReads,
            expiry: retryExpiryInputValues.length,
            authority: authorityReads,
            count: expiredCounts,
            transaction: transactions,
            wake: wakeRequests
        }),
        transactionCount: () => transactions
    };
}

interface AdminPruneIdempotencyIdentityInput {
    readonly requestId: string;
    readonly requestedBy: string;
    readonly requestedSessionId: string;
    readonly categories: readonly AdminPruneExpiredCategory[];
    readonly appData: Readonly<{ namespace: string; storeName: string | null; }> | null;
    readonly dryRun: boolean;
}

interface AdminPruneIdempotencyIdentity extends AdminPruneIdempotencyIdentityInput {
    readonly version: 1;
    readonly contextId: string;
    readonly jobId: string;
    readonly semanticHash: string;
}

function createObservedDatabase(
    database: ReturnType<typeof createAppInboxTestDatabase>,
    events: string[],
    lookupRecorder: Readonly<{
        recordOutboxWinnerLookup(): void;
        recordDurableResultLookup(): void;
    }>
): PSqlSql {
    const observed = ((strings: TemplateStringsArray, ...values: Parameters<PSqlSql>[0]) => database(strings, ...values)) as PSqlSql;
    Object.defineProperties(observed, Object.getOwnPropertyDescriptors(database));
    observed.begin = async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> =>
        await database.begin(
            async (transaction) => await write(createObservedTransaction(transaction, events, lookupRecorder))
        );
    return observed;
}

function createObservedTransaction(
    transaction: PSqlSql,
    events: string[],
    lookupRecorder: Readonly<{
        recordOutboxWinnerLookup(): void;
        recordDurableResultLookup(): void;
    }>
): PSqlSql {
    const observed = (async (strings: TemplateStringsArray, ...values: Parameters<PSqlSql>[0]) => {
        const query = strings.join(' ').replace(/\s+/gu, ' ').trim().toLowerCase();
        if (query.includes('from resource_inbox') && query.includes('limit 1')) {
            lookupRecorder.recordOutboxWinnerLookup();
        }
        if (query.includes('from resource_inbox_results') && query.includes('limit 1')) {
            lookupRecorder.recordDurableResultLookup();
        }
        if (query.includes('insert into resource_inbox_results')) {
            events.push(values[1] === ADMIN_PRUNE_AGGREGATE_TOPIC ? 'aggregate-write' : 'result-write');
        }
        else if (query.includes('insert into resource_inbox')) {
            events.push('page-write');
        }
        return await transaction(strings, ...values);
    }) as typeof transaction;
    observed.begin = transaction.begin;
    return observed;
}

function recordAdminPrunePhase(
    events: string[],
    timingEvents: RallarTimingEvent[],
    event: RallarTimingEvent
): void {
    if (event.component !== 'admin-prune-inbox') {
        return;
    }
    timingEvents.push(event);
    events.push(`phase:${event.operation}`);
}

function readSemanticHashes(timingEvents: readonly RallarTimingEvent[]): readonly string[] {
    return timingEvents
        .filter((event) => event.operation === 'semantic-identity')
        .map((event) => event.details?.semanticHash)
        .filter((semanticHash): semanticHash is string => typeof semanticHash === 'string');
}

function createAdminSession(clientId: string, sessionId: string): AuthSession {
    return {
        clientId,
        username: clientId,
        sessionId,
        accessToken: 'test-only-token',
        expiresAtEpochMs: INITIAL_TIME_EPOCH_MS + 3_600_000
    };
}

async function completePrune(
    harness: AdminInboxHarness,
    adminSession: AuthSession,
    request: AdminPruneRequestFixture
) {
    return await completePruneAttempts({ harness, adminSession, request, dequeueAttempts: 1 });
}

interface CompletePruneAttemptsInput {
    readonly harness: AdminInboxHarness;
    readonly adminSession: AuthSession;
    readonly request: AdminPruneRequestFixture;
    readonly dequeueAttempts: number;
}

async function completePruneAttempts({
    harness,
    adminSession,
    request,
    dequeueAttempts
}: CompletePruneAttemptsInput) {
    const pending = harness.service.pruneExpired({ adminSession, ...toPruneInput(request) });
    for (let attempt = 0; attempt < dequeueAttempts; attempt += 1) {
        if (attempt === 0) {
            await waitForQueueEntry(harness.queue);
        }
        else {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await dequeueInitialCommand(harness);
    }
    return await pending;
}

async function dequeueInitialCommand(harness: AdminInboxHarness): Promise<void> {
    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
}

async function readOnlyCommand(
    queue: TestResourceInbox,
    requestId?: string,
    clientId?: string
): Promise<AdminPruneCommand> {
    const commands = await listCommands(queue, requestId, clientId);
    const command = commands[0];
    if (!command) {
        throw new Error('Expected one admin prune command');
    }
    return command;
}

async function listCommands(
    queue: TestResourceInbox,
    requestId?: string,
    clientId?: string
): Promise<readonly AdminPruneCommand[]> {
    const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));
    return entries
        .filter((entry): entry is ResourceEntry => entry !== undefined)
        .map((entry) => {
            const message: ALMessage = JSON.parse(entry.resource);
            const enqueue: { data: JsonWireValue; } = JSON.parse(message.payload.resource);
            return { entry, command: decodeAdminPruneCommand(enqueue.data) };
        })
        .filter(({ entry }) => requestId === undefined || entry.key.resourceId === requestId)
        .filter(({ command }) => clientId === undefined || command.requestedBy === clientId)
        .map(({ command }) => command);
}
