import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import {
    DequeueResourceEntryController,
    ResilienceDto,
    type ResourceInboxRetryExhaustion,
    type ResourceInboxRetryExhaustionRecovery,
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import { DequeueController } from '@shared/queuebox/DequeueController.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry,
    toKeyAsString,
} from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
    type AppInboxMessageContext,
    AppInboxReservationConflictError,
    AppInboxService,
    AppInboxType,
    classifyAppInboxError,
    createAppInboxRetryExhaustionHandler,
    createAppInboxRetryExhaustionRecoveryHandler,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';
import { GroupMutationAuthorizationError } from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupTopologyConfigValidationError } from '@shared-server/rallar-system/services/group-topology-config-service.ts';
import { readPersistedAppInboxFailure } from '@shared-server/rallar-system/services/app-inbox-failure.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

const NOW_EPOCH_MS = Date.parse('2026-07-22T12:00:00.000Z');

describe('AppInboxService transaction ownership', () => {
    it('commits mutation, outbox, result, and completion in one transaction', async () => {
        const harness = createAtomicHarness();
        const receipt = { status: 'accepted', revision: 2 } as const;

        const result = await harness.service.commit(harness.context, async (transaction) => {
            expect(transaction).toBe(harness.database.activeTransaction);
            harness.database.writeMutation('group-1', { revision: 2 });
            harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
            return receipt;
        });

        expect(result).toEqual(receipt);
        expect(harness.database.beginCalls).toBe(1);
        expect(harness.database.state.mutations.get('group-1')).toEqual({ revision: 2 });
        expect(harness.database.state.outbox.get('outbox-1')).toEqual({ groupId: 'group-1' });
        expect(
            JSON.parse(
                harness.database.state.results.get(toKeyAsString(harness.entry.key))!.resource,
            ),
        )
            .toEqual(receipt);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
            .toBe(EntityStatus.COMPLETED);
    });

    it.each(['dependent-write', 'outbox-write'] as const)(
        'rolls the mutation back when the %s fails',
        async (failurePhase) => {
            const harness = createAtomicHarness();

            await expect(harness.service.commit(harness.context, async () => {
                harness.database.writeMutation('group-1', { revision: 2 });
                if (failurePhase === 'dependent-write') {
                    throw new Error('dependent write failed');
                }
                harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
                throw new Error('outbox write failed');
            })).rejects.toThrow(`${failurePhase.split('-')[0]} write failed`);

            expect(harness.database.state.mutations.size).toBe(0);
            expect(harness.database.state.outbox.size).toBe(0);
            expect(harness.database.state.results.size).toBe(0);
            expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
                .toBe(EntityStatus.RESERVED);
        },
    );

    it('rolls every successful write back when the result write fails', async () => {
        const harness = createAtomicHarness({ failResultWrite: true });

        await expect(harness.service.commit(harness.context, async () => {
            harness.database.writeMutation('group-1', { revision: 2 });
            harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
            return { status: 'accepted' };
        })).rejects.toThrow('result write failed');

        expect(harness.database.state.mutations.size).toBe(0);
        expect(harness.database.state.outbox.size).toBe(0);
        expect(harness.database.state.results.size).toBe(0);
    });

    it('rolls every successful write back when reservation ownership changed', async () => {
        const harness = createAtomicHarness({ loseReservation: true });

        await expect(harness.service.commit(harness.context, async () => {
            harness.database.writeMutation('group-1', { revision: 2 });
            harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
            return { status: 'accepted' };
        })).rejects.toBeInstanceOf(AppInboxReservationConflictError);
        await expect(harness.service.commit(harness.context, async () => undefined))
            .rejects.toMatchObject({ code: 'app-inbox-reservation-conflict' });

        expect(harness.database.state.mutations.size).toBe(0);
        expect(harness.database.state.outbox.size).toBe(0);
        expect(harness.database.state.results.size).toBe(0);
    });

    it('writes terminal policy denial result and FAILED completion atomically', async () => {
        const harness = createAtomicHarness();
        const denial = new GroupPolicyDeniedError({
            allowed: false,
            code: 'group-policy-denied',
            message: 'membership is required',
            details: { groupId: 'group-1' },
        });

        const classification = classifyAppInboxError(denial);
        expect(classification).toMatchObject({ kind: 'terminal' });
        if (classification.kind !== 'terminal') throw new Error('Expected terminal denial');
        await harness.service.fail(harness.context, classification.result);

        const stored = harness.database.state.results.get(toKeyAsString(harness.entry.key));
        expect(stored?.status).toBe(EntityStatus.FAILED);
        expect(JSON.parse(stored!.resource)).toMatchObject({
            code: 'group-policy-denied',
            message: 'membership is required',
        });
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
            .toBe(EntityStatus.FAILED);
    });

    it('classifies CAS conflicts as retryable without writing a result', async () => {
        const harness = createAtomicHarness();
        const conflict = Object.assign(new Error('conditional write lost'), {
            code: 'runtime-state-write-conflict',
            status: 503,
        });

        expect(classifyAppInboxError(conflict)).toEqual({
            kind: 'retryable',
            code: 'runtime-state-write-conflict',
            message: 'AppInbox processing encountered a retryable conflict',
        });
        expect(harness.database.state.results.size).toBe(0);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
            .toBe(EntityStatus.RESERVED);

        expect(classifyAppInboxError(
            new AppInboxReservationConflictError(harness.entry.key),
        )).toMatchObject({
            kind: 'retryable',
            code: 'app-inbox-reservation-conflict',
        });
    });

    it('records transaction and write timing for the exact winning attempt without a plan field', async () => {
        const timing: RallarTimingEvent[] = [];
        const harness = createAtomicHarness({ timing: (event) => timing.push(event) });

        await harness.service.commit(harness.context, async () => ({ status: 'accepted' }));

        expect(timing.filter((event) => event.operation === 'transaction')).toHaveLength(1);
        expect(timing.filter((event) => event.operation === 'write')).toHaveLength(1);
        for (const event of timing) {
            expect(event.details).toMatchObject({ attempt: 7 });
            expect(event.details).not.toHaveProperty('plan');
        }
    });
});

describe('AppInboxService registered handler finalization', () => {
    it('does not run legacy result persistence after a transaction-owned handler commits', async () => {
        const timing: RallarTimingEvent[] = [];
        const harness = createRegisteredHandlerHarness({
            failResultWriteAfter: 1,
            timing: (event) => timing.push(event),
        });
        harness.service.onStateMessage(
            AppInboxType.GROUP_CREATE,
            async (_data, context) =>
                await harness.service.commit(
                context,
                async () => ({ status: 'accepted', source: 'transaction' }),
            ),
        );

        const pending = harness.service.processEntryUntilCompletion(harness.enqueue);
        await harness.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        await expect(pending).resolves.toMatchObject({
            right: { status: 'accepted', source: 'transaction' },
        });
        expect(harness.results.replaceCalls).toBe(1);
        expect(harness.readEntry()?.status).toBe(EntityStatus.COMPLETED);
        expect(timing).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'queue-retry' }),
        ]));
    });

    it('returns the committed result when handler code throws after transaction finalization', async () => {
        const timing: RallarTimingEvent[] = [];
        const harness = createRegisteredHandlerHarness({
            timing: (event) => timing.push(event),
        });
        harness.service.onStateMessage(
            AppInboxType.GROUP_CREATE,
            async (_data, context) => {
                await harness.service.commit(
                    context,
                    async () => ({ status: 'accepted', source: 'transaction' }),
                );
                throw new Error('secret-after-commit');
            },
        );

        const pending = harness.service.processEntryUntilCompletion(harness.enqueue);
        await harness.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        await expect(pending).resolves.toMatchObject({
            right: { status: 'accepted', source: 'transaction' },
        });
        expect(harness.results.replaceCalls).toBe(1);
        expect(timing).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'queue-retry' }),
        ]));
    });

    it('persists a legacy handler result exactly once', async () => {
        const harness = createRegisteredHandlerHarness();
        harness.service.onStateMessage(
            AppInboxType.GROUP_CREATE,
            async () => ({ status: 'accepted', source: 'legacy' }),
        );

        const pending = harness.service.processEntryUntilCompletion(harness.enqueue);
        await harness.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        await expect(pending).resolves.toMatchObject({
            right: { status: 'accepted', source: 'legacy' },
        });
        expect(harness.results.replaceCalls).toBe(1);
    });

    it('classifies malformed persisted handler JSON as terminal without invoking the handler', async () => {
        const harness = createRegisteredHandlerHarness();
        const handler = vi.fn(async () => ({ status: 'unexpected' }));
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, handler);
        harness.service.processEntryNoWaiting(harness.enqueue);
        const entry = await waitForRegisteredHandlerEntry(harness.queue);
        const message = JSON.parse(entry.resource) as {
            payload: { resource: string };
        };
        message.payload.resource = '{"malformed":';
        await harness.queue.enqueue({
            ...entry,
            resource: JSON.stringify(message),
        });

        await harness.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        expect(handler).not.toHaveBeenCalled();
        expect(harness.readEntry()?.status).toBe(EntityStatus.FAILED);
        expect([...harness.results.entries.values()]).toEqual([
            expect.objectContaining({ status: EntityStatus.FAILED }),
        ]);
    });

    it.each([
        {
            name: 'known outer and nested mismatch',
            outerType: AppInboxType.GROUP_UPDATE as string,
            nested: { kind: 'operation' as const, type: AppInboxType.GROUP_CREATE as string },
            topicId: 'app-inbox.group-state',
            valid: false,
        },
        {
            name: 'missing nested type',
            outerType: AppInboxType.GROUP_CREATE as string,
            nested: { kind: 'missing' as const },
            topicId: 'app-inbox.group-state',
            valid: false,
        },
        {
            name: 'unknown removed nested type',
            outerType: AppInboxType.GROUP_CREATE as string,
            nested: { kind: 'operation' as const, type: 'REMOVED_GROUP_password' },
            topicId: 'app-inbox.group-state',
            valid: false,
        },
        {
            name: 'unknown removed outer type with a registered callback',
            outerType: 'REMOVED_GROUP_password',
            nested: { kind: 'operation' as const, type: 'REMOVED_GROUP_password' },
            topicId: 'app-inbox.group-state',
            valid: false,
        },
        {
            name: 'wrong durable queue topic',
            outerType: AppInboxType.GROUP_CREATE as string,
            nested: { kind: 'operation' as const, type: AppInboxType.GROUP_CREATE as string },
            topicId: 'app-inbox.client-state',
            valid: false,
        },
        {
            name: 'corrupt nested JSON',
            outerType: AppInboxType.GROUP_CREATE as string,
            nested: { kind: 'corrupt' as const },
            topicId: 'app-inbox.group-state',
            valid: false,
        },
        {
            name: 'unsupported group exact-operation durable topic',
            outerType: AppInboxType.GROUP_CREATE as string,
            nested: { kind: 'operation' as const, type: AppInboxType.GROUP_CREATE as string },
            topicId: AppInboxType.GROUP_CREATE as string,
            valid: false,
        },
        {
            name: 'unsupported client exact-operation durable topic',
            outerType: AppInboxType.CLIENT_SESSION_CONNECT as string,
            nested: {
                kind: 'operation' as const,
                type: AppInboxType.CLIENT_SESSION_CONNECT as string,
            },
            topicId: AppInboxType.CLIENT_SESSION_CONNECT as string,
            valid: false,
        },
        {
            name: 'valid outer nested and topic agreement',
            outerType: AppInboxType.GROUP_CREATE as string,
            nested: { kind: 'operation' as const, type: AppInboxType.GROUP_CREATE as string },
            topicId: 'app-inbox.group-state',
            valid: true,
        },
        {
            name: 'valid operation-specific durable topic agreement',
            outerType: AppInboxType.CLIENT_EXPIRED_SESSIONS as string,
            nested: {
                kind: 'operation' as const,
                type: AppInboxType.CLIENT_EXPIRED_SESSIONS as string,
            },
            topicId: AppInboxType.CLIENT_EXPIRED_SESSIONS as string,
            valid: true,
        },
    ].flatMap((testCase) => [
        { ...testCase, attempt: 1 },
        { ...testCase, attempt: 19 },
    ]))('validates $name before attempt $attempt handler dispatch', async ({
        outerType,
        nested,
        topicId,
        valid,
        attempt,
    }) => {
        const timing: RallarTimingEvent[] = [];
        const harness = createRegisteredHandlerHarness({
            timing: (event) => timing.push(event),
            topicId,
        });
        let mutationCommitted = false;
        const handler = vi.fn(async (_data, context) =>
            await harness.service.commit(context, async () => {
                mutationCommitted = true;
                return { status: 'accepted' };
            })
        );
        harness.service.onStateMessage(outerType as AppInboxType, handler);
        harness.service.processEntryNoWaiting(harness.enqueue);
        const entry = await waitForRegisteredHandlerEntry(harness.queue);
        await harness.queue.enqueue({
            ...entry,
            resource: toRegisteredHandlerIdentityResource(entry, { outerType, nested }),
            status: EntityStatus.NEW,
            dequeueAudit: { attempts: attempt - 1 },
        });

        await harness.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        const finalized = harness.readEntry()!;
        const result = harness.results.entries.get(toKeyAsString(finalized.key));

        expect(finalized.dequeueAudit.attempts).toBe(attempt);
        expect(finalized.dequeueAudit.nextTs).toBeUndefined();
        if (valid) {
            expect(handler).toHaveBeenCalledTimes(1);
            expect(mutationCommitted).toBe(true);
            expect(finalized.status).toBe(EntityStatus.COMPLETED);
            expect(result?.status).toBe(EntityStatus.COMPLETED);
        } else {
            expect(handler).not.toHaveBeenCalled();
            expect(mutationCommitted).toBe(false);
            expect(finalized.status).toBe(EntityStatus.FAILED);
            expect(result?.status).toBe(EntityStatus.FAILED);
            expect(JSON.parse(result!.resource)).toMatchObject({
                code: 'app-inbox-malformed-command',
                status: 400,
            });
            expect(result?.resource).not.toContain('password');
        }
        expect(timing).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'queue-retry' }),
        ]));

        await harness.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        expect(harness.readEntry()?.dequeueAudit.attempts).toBe(attempt);
        expect(handler).toHaveBeenCalledTimes(valid ? 1 : 0);
    });

    it('prevents a mismatched identity from entering a transaction-owned mutation callback', async () => {
        const harness = createRegisteredHandlerHarness();
        let mutationCommitted = false;
        const handler = vi.fn(async (_data, context) =>
            await harness.service.commit(context, async () => {
                mutationCommitted = true;
                return { status: 'accepted' };
            })
        );
        harness.service.onStateMessage(AppInboxType.GROUP_UPDATE, handler);
        harness.service.processEntryNoWaiting(harness.enqueue);
        const entry = await waitForRegisteredHandlerEntry(harness.queue);
        await harness.queue.enqueue({
            ...entry,
            resource: toRegisteredHandlerIdentityResource(entry, {
                outerType: AppInboxType.GROUP_UPDATE,
                nested: {
                    kind: 'operation',
                    type: AppInboxType.GROUP_CREATE,
                },
            }),
        });

        await harness.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        expect(handler).not.toHaveBeenCalled();
        expect(mutationCommitted).toBe(false);
        expect(harness.readEntry()?.status).toBe(EntityStatus.FAILED);
        expect(harness.readEntry()?.dequeueAudit.attempts).toBe(1);
    });
});

describe('AppInbox error classification', () => {
    it('fails closed when persisted failure metadata is structurally corrupt', () => {
        const malformed = readPersistedAppInboxFailure(JSON.stringify({
            type: 'app-inbox-retry-exhausted',
            status: 503,
            message: 'AppInbox processing exhausted its retry budget',
            issues: null,
            denial: null,
            retry: {
                kind: 'exhausted',
                attempts: 20,
                lane: 'NEW',
                queueAgeMs: 10,
                dueAgeMs: 5,
            },
            commandIdentity: {
                contextId: '',
                resourceId: 'request-1',
                topicId: 'app-inbox.group-state',
                operation: 'TOPOLOGY_CONFIG_PUT',
                operationSource: 'command',
            },
            selectedLane: 'NEW',
            processingAttempts: 20,
            reservationAttempt: 20,
            lastError: {
                source: 'processing',
                code: 'runtime-state-write-conflict',
                message: 'retryable conflict',
            },
            queueAgeMs: 10,
            dueAgeMs: 5,
            exhaustedAtEpochMs: NOW_EPOCH_MS,
        }));

        expect(malformed).toEqual({
            type: 'app-inbox-failure',
            version: 'malformed.v0',
            code: 'app-inbox-malformed-persisted-failure',
            status: 500,
            message: 'Persisted AppInbox failure is malformed',
            issues: null,
            denial: null,
            retry: null,
        });
    });

    it('serializes validation and authority failures with mandatory structured fields', () => {
        const validation = classifyAppInboxError(
            new GroupTopologyConfigValidationError([{
                code: 'invalid-positive-integer',
                path: ['degreeLimit'],
                message: 'degreeLimit must be a positive integer',
                details: { value: 0 },
            }]),
        );
        expect(validation).toEqual({
            kind: 'terminal',
            code: 'group-topology-config-validation-failed',
            result: {
                type: 'app-inbox-failure',
                version: 'canonical.v2',
                code: 'group-topology-config-validation-failed',
                status: 422,
                message: 'Group topology config validation failed',
                issues: [{
                    code: 'invalid-positive-integer',
                    path: ['degreeLimit'],
                    message: 'degreeLimit must be a positive integer',
                    details: { value: 0 },
                }],
                denial: null,
                retry: null,
            },
        });

        const authority = classifyAppInboxError(
            new GroupMutationAuthorizationError('session was revoked'),
        );
        expect(authority).toEqual({
            kind: 'terminal',
            code: 'group-mutation-authority-denied',
            result: {
                type: 'app-inbox-failure',
                version: 'canonical.v2',
                code: 'group-mutation-authority-denied',
                status: 403,
                message: 'Forbidden: session was revoked',
                issues: null,
                denial: {
                    code: 'group-mutation-authority-denied',
                    message: 'Forbidden: session was revoked',
                    details: null,
                },
                retry: null,
            },
        });
    });

    it.each([
        {
            name: 'typed reservation conflict with 409',
            error: Object.assign(new Error('reservation changed'), {
                code: 'app-inbox-reservation-conflict',
                status: 409,
            }),
            kind: 'retryable',
        },
        {
            name: 'typed CAS conflict with 409',
            error: Object.assign(new Error('predecessor changed'), {
                code: 'runtime-state-write-conflict',
                status: 409,
            }),
            kind: 'retryable',
        },
        {
            name: 'typed transient error',
            error: Object.assign(new Error('database unavailable'), {
                code: 'app-inbox-transient',
                status: 503,
            }),
            kind: 'retryable',
        },
        {
            name: 'authorization denial',
            error: Object.assign(new Error('forbidden'), {
                code: 'group-mutation-authority-denied',
                status: 403,
            }),
            kind: 'terminal',
        },
        {
            name: 'malformed command with non-4xx status',
            error: Object.assign(new Error('invalid command'), {
                code: 'app-inbox-malformed-command',
                status: 503,
            }),
            kind: 'terminal',
        },
        {
            name: 'invariant corruption with non-4xx status',
            error: Object.assign(new Error('corrupt state'), {
                code: 'resource-inbox-invariant-corruption',
                status: 503,
            }),
            kind: 'terminal',
        },
        {
            name: 'lifecycle rejection with non-4xx status',
            error: Object.assign(new Error('expired lifecycle'), {
                code: 'app-inbox-lifecycle-rejected',
                status: 503,
            }),
            kind: 'terminal',
        },
        {
            name: 'syntax decoding failure',
            error: new SyntaxError('unexpected token secret'),
            kind: 'terminal',
        },
        {
            name: 'type decoding failure',
            error: new TypeError('invalid persisted shape secret'),
            kind: 'terminal',
        },
        {
            name: 'unknown error',
            error: new Error('unknown failure'),
            kind: 'retryable',
        },
        ...[
            'future-validation-timeout',
            'network-collision-course',
            'transient-invariant-corruption-wrapper',
            'authority-denied-by-upstream-ish',
            'policy-denied-retry-proxy',
            'lifecycle-rejected-temporarily',
        ].map((code) => ({
            name: `unknown fragment-bearing code ${code}`,
            error: Object.assign(new Error('unknown transient failure'), { code }),
            kind: 'retryable' as const,
        })),
        {
            name: 'known idempotency conflict',
            error: Object.assign(new Error('command identity changed'), {
                code: 'app-inbox-idempotency-conflict',
                status: 409,
            }),
            kind: 'terminal',
        },
        {
            name: 'known mutation rejection',
            error: Object.assign(new Error('mutation rejected'), {
                code: 'group-mutation-rejected',
                status: 409,
            }),
            kind: 'terminal',
        },
    ])('classifies $name by typed code precedence', ({ error, kind }) => {
        expect(classifyAppInboxError(error).kind).toBe(kind);
    });
});

describe('AppInbox retry exhaustion', () => {
    it('persists mandatory attempt-20 diagnostics and FAILED completion in one transaction', async () => {
        const harness = createAtomicHarness({ attempts: 20 });
        const telemetry: ResourceInboxRetryExhaustion[] = [];
        const releaseEntries = vi.fn();
        const onRetryExhausted = createAppInboxRetryExhaustionHandler({
            database: harness.database.sql,
        });
        let reserved = false;
        const controller = DequeueResourceEntryController.toDequeuer<Key>(
            {
                isAnyEntryToLock: async () => true,
                reserveEntries: async () => {
                    if (reserved) return new Map();
                    reserved = true;
                    return new Map([[harness.entry.key, harness.entry]]);
                },
                reserveTimeoutEntries: async () => new Map(),
                reserveOverdueRetryEntries: async () => new Map(),
                reserveRetryExhaustionFinalizations: async () => new Map(),
                releaseEntries,
            },
            () => new Set([EnqueuedType.APP_INBOX]),
            () => 1,
            20,
            1,
            createResilience(),
            {
                nowEpochMs: () => NOW_EPOCH_MS,
                jitterUnit: () => 0.5,
                onRetryExhausted,
                onRetryExhaustionTelemetry: (event) => {
                    if (event.failure.source === 'processing') {
                        telemetry.push(event as ResourceInboxRetryExhaustion);
                    }
                },
            },
        );

        await controller.dequeueForCompute(async () => {
            throw Object.assign(new Error('conditional write lost secret=password-123'), {
                code: 'runtime-state-write-conflict',
            });
        });

        expect(releaseEntries).not.toHaveBeenCalled();
        expect(harness.database.beginCalls).toBe(1);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
            .toBe(EntityStatus.FAILED);
        const stored = harness.database.state.results.get(toKeyAsString(harness.entry.key));
        expect(stored?.status).toBe(EntityStatus.FAILED);
        expect(JSON.parse(stored!.resource)).toEqual({
            type: 'app-inbox-retry-exhausted',
            status: 503,
            message: 'AppInbox processing exhausted its retry budget',
            issues: null,
            denial: null,
            retry: {
                kind: 'exhausted',
                attempts: 20,
                lane: 'NEW',
                queueAgeMs: expect.any(Number),
                dueAgeMs: expect.any(Number),
            },
            commandIdentity: {
                contextId: harness.entry.key.contextId,
                resourceId: harness.entry.key.resourceId,
                topicId: harness.entry.key.topicId,
                operation: AppInboxType.GROUP_CREATE,
                operationSource: 'command',
            },
            selectedLane: 'NEW',
            processingAttempts: 20,
            reservationAttempt: 20,
            lastError: {
                source: 'processing',
                code: 'runtime-state-write-conflict',
                message: 'AppInbox processing encountered a retryable conflict',
            },
            queueAgeMs: expect.any(Number),
            dueAgeMs: expect.any(Number),
            exhaustedAtEpochMs: NOW_EPOCH_MS,
        });
        expect(telemetry).toEqual([
            expect.objectContaining({
                processingAttempts: 20,
                reservationAttempt: 20,
                lane: 'NEW',
                classification: 'retryable',
                exhausted: true,
                queueAgeMs: expect.any(Number),
                dueAgeMs: expect.any(Number),
            }),
        ]);
        expect(stored?.resource).not.toContain('password-123');
    });

    it.each([
        {
            name: 'corrupt outer JSON',
            resource: '{"secret":"outer-password"',
            operationSource: 'corrupt',
            operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
        },
        {
            name: 'corrupt nested command JSON',
            resource: JSON.stringify({
                payload: {
                    typeId: AppInboxType.GROUP_CREATE,
                    resource: '{"secret":"nested-password"',
                },
            }),
            operationSource: 'corrupt',
            operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
        },
        {
            name: 'missing outer dispatch type',
            resource: toPersistedAppInboxResource({
                nestedType: AppInboxType.GROUP_CREATE,
            }),
            operationSource: 'corrupt',
            operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
        },
        {
            name: 'known outer and nested operation mismatch',
            resource: toPersistedAppInboxResource({
                outerType: AppInboxType.GROUP_UPDATE,
                nestedType: AppInboxType.GROUP_CREATE,
            }),
            operationSource: 'corrupt',
            operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
        },
        {
            name: 'missing nested command type',
            resource: toPersistedAppInboxResource({
                outerType: AppInboxType.GROUP_CREATE,
            }),
            operationSource: 'corrupt',
            operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
        },
        {
            name: 'durable queue topic mismatch',
            resource: toPersistedAppInboxResource({
                outerType: AppInboxType.GROUP_CREATE,
                nestedType: AppInboxType.GROUP_CREATE,
            }),
            topicId: 'app-inbox.client-state',
            operationSource: 'corrupt',
            operation: 'APP_INBOX_CLIENT_OPERATION_UNAVAILABLE',
        },
        {
            name: 'valid outer nested and topic agreement',
            resource: toPersistedAppInboxResource({
                outerType: AppInboxType.GROUP_CREATE,
                nestedType: AppInboxType.GROUP_CREATE,
            }),
            operationSource: 'command',
            operation: AppInboxType.GROUP_CREATE,
        },
        {
            name: 'unknown removed outer dispatch type',
            resource: toPersistedAppInboxResource({
                outerType: 'REMOVED_GROUP_OPERATION_password',
                nestedType: AppInboxType.GROUP_CREATE,
            }),
            operationSource: 'unavailable',
            operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
        },
        {
            name: 'unknown removed nested command type',
            resource: toPersistedAppInboxResource({
                outerType: AppInboxType.GROUP_CREATE,
                nestedType: 'REMOVED_GROUP_OPERATION_password',
            }),
            operationSource: 'unavailable',
            operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
        },
    ].flatMap((testCase) => [
        { ...testCase, lane: 'initial' as const, attempts: 20 },
        { ...testCase, lane: 'recovery' as const, attempts: 21 },
    ]))('atomically finalizes $lane exhaustion with $name', async ({
        resource,
        operationSource,
        operation,
        topicId,
        lane,
        attempts,
    }) => {
        const harness = createAtomicHarness({
            attempts,
            entryResource: resource,
            entryTopicId: topicId,
        });
        const domainHandler = vi.fn();
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, domainHandler);
        if (lane === 'initial') {
            await createAppInboxRetryExhaustionHandler({
                database: harness.database.sql,
            })(toExhaustion(harness.entry));
        } else {
            await createAppInboxRetryExhaustionRecoveryHandler({
                database: harness.database.sql,
            })(toRecovery(harness.entry, attempts));
        }

        const stored = harness.database.state.results.get(toKeyAsString(harness.entry.key));
        expect(harness.database.beginCalls).toBe(1);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
            .toBe(EntityStatus.FAILED);
        expect(
            harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.dequeueAudit
                .attempts,
        )
            .toBe(attempts);
        expect(stored?.status).toBe(EntityStatus.FAILED);
        expect(JSON.parse(stored!.resource)).toMatchObject({
            commandIdentity: {
                operation,
                operationSource,
            },
            processingAttempts: 20,
            reservationAttempt: attempts,
        });
        expect(stored?.resource).not.toContain('password');
        expect(domainHandler).not.toHaveBeenCalled();
    });

    it('rolls back a lost recovery reservation and finalizes a later reservation generation', async () => {
        const harness = createAtomicHarness({ attempts: 21, loseReservation: true });
        const recover = createAppInboxRetryExhaustionRecoveryHandler({
            database: harness.database.sql,
        });

        await expect(recover(toRecovery(harness.entry, 21)))
            .rejects.toBeInstanceOf(AppInboxReservationConflictError);
        expect(harness.database.state.results.size).toBe(0);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
            .toBe(EntityStatus.RESERVED);

        const attempt22 = harness.database.reclaimFinalization();
        harness.database.loseReservation = false;
        await recover(toRecovery(attempt22, 22));

        const stored = harness.database.state.results.get(toKeyAsString(harness.entry.key));
        expect(harness.database.beginCalls).toBe(2);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
            .toBe(EntityStatus.FAILED);
        expect(JSON.parse(stored!.resource)).toMatchObject({
            selectedLane: 'FINALIZATION',
            processingAttempts: 20,
            reservationAttempt: 22,
            finalizedAtEpochMs: NOW_EPOCH_MS,
            lastError: {
                source: 'finalization-recovery',
                code: 'app-inbox-finalization-recovery',
            },
        });
    });
});

class AtomicAppInboxService extends AppInboxService {
    async commit<R>(
        context: AppInboxMessageContext,
        write: (transaction: PSqlTransactionSql) => Promise<R>,
    ): Promise<R> {
        return await this.writeMutation(context, write);
    }

    async fail(context: AppInboxMessageContext, error: unknown): Promise<void> {
        await this.writeTerminalFailure(context, error);
    }
}

class RegisteredHandlerInbox extends InMemoryQueueBox {
    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }
}

class RegisteredHandlerResults {
    readonly entries = new Map<string, ResourceEntry>();
    replaceCalls = 0;

    constructor(private readonly failResultWriteAfter?: number) {}

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.replaceCalls += 1;
        if (
            this.failResultWriteAfter !== undefined &&
            this.replaceCalls > this.failResultWriteAfter
        ) {
            throw new Error('legacy result write must not run');
        }
        this.entries.set(toKeyAsString(entry.key), entry);
        return entry;
    }

    async findByKey(key: Key): Promise<ResourceEntry | undefined> {
        return this.entries.get(toKeyAsString(key));
    }
}

function createRegisteredHandlerHarness(options: Readonly<{
    failResultWriteAfter?: number;
    timing?: (event: RallarTimingEvent) => void;
    topicId?: string;
}> = {}) {
    const queue = new RegisteredHandlerInbox();
    const results = new RegisteredHandlerResults(options.failResultWriteAfter);
    const reader = new InboxQueueReader(queue);
    const service = new AtomicAppInboxService(
        reader,
        queue as never,
        results as never,
        createAppInboxTestDatabase(queue, results),
        'server-1',
        'app-inbox.group-state',
        options.timing,
        {
            phaseTiming: true,
            waitMaxElapsedMsecs: 5_000,
            waitRetryIntervalMsecs: 1,
            waitMaxRetryIntervalMsecs: 1,
            waitJitterRatio: 0,
        },
    );
    const enqueue = {
        type: AppInboxType.GROUP_CREATE,
        topicId: options.topicId ?? 'app-inbox.group-state',
        resourceId: 'registered-handler-request',
        contextId: 'group-1',
        data: { requestId: 'registered-handler-request' },
    } as const;
    return {
        enqueue,
        queue,
        readEntry: () =>
            (
            queue as unknown as { data: Map<string, ResourceEntry> }
        ).data.values().next().value as ResourceEntry | undefined,
        reader,
        results,
        service,
    };
}

async function waitForRegisteredHandlerEntry(
    queue: RegisteredHandlerInbox,
): Promise<ResourceEntry> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const entry = (
            queue as unknown as { data: Map<string, ResourceEntry> }
        ).data.values().next().value as ResourceEntry | undefined;
        if (entry) return entry;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Expected registered handler entry');
}

function toRegisteredHandlerIdentityResource(
    entry: ResourceEntry,
    identity: Readonly<{
        outerType: string;
        nested:
            | Readonly<{ kind: 'operation'; type: string }>
            | Readonly<{ kind: 'missing' }>
            | Readonly<{ kind: 'corrupt' }>;
    }>,
): string {
    const message = JSON.parse(entry.resource) as {
        payload: { typeId: string; resource: string };
    };
    message.payload.typeId = identity.outerType;
    message.payload.resource = identity.nested.kind === 'corrupt'
        ? '{"secret":"nested-password"'
        : JSON.stringify(
            identity.nested.kind === 'missing' ? { data: { secret: 'nested-password' } } : {
                type: identity.nested.type,
                data: { secret: 'nested-password' },
            },
        );
    return JSON.stringify(message);
}

type AtomicState = {
    mutations: Map<string, unknown>;
    outbox: Map<string, unknown>;
    inbox: Map<string, ResourceEntry>;
    results: Map<string, ResourceEntry>;
};

class AtomicDatabase {
    state: AtomicState;
    beginCalls = 0;
    activeTransaction: PSqlTransactionSql | undefined;
    private working: AtomicState | undefined;
    loseReservation: boolean;

    readonly sql: PSqlSql;

    constructor(
        entry: ResourceEntry,
        private readonly options: Readonly<{
            failResultWrite: boolean;
            loseReservation: boolean;
        }>,
    ) {
        this.loseReservation = options.loseReservation;
        this.state = {
            mutations: new Map(),
            outbox: new Map(),
            inbox: new Map([[toKeyAsString(entry.key), entry]]),
            results: new Map(),
        };
        const sql = (async () => {
            throw new Error('Unexpected raw SQL in atomic test database');
        }) as unknown as PSqlSql;
        sql.begin = async <T>(write: (transaction: PSqlTransactionSql) => Promise<T>) => {
            this.beginCalls += 1;
            const transaction = (async (
                strings: TemplateStringsArray,
                ...values: unknown[]
            ) => {
                const query = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
                if (query.includes('insert into resource_inbox_results')) {
                    if (this.options.failResultWrite) throw new Error('result write failed');
                    const result = toAtomicResultEntry(values);
                    this.requireWorking().results.set(toKeyAsString(result.key), result);
                    return [toAtomicResultRow(result)];
                }
                if (
                    query.includes('update resource_inbox') &&
                    query.includes("ri_status = 'reserved'")
                ) {
                    const [status, completedAt, topicId, resourceId, contextId, attempts] =
                        values as [
                            EntityStatus,
                            Date,
                            string,
                            string,
                            string,
                            number,
                        ];
                    if (this.loseReservation) return [];
                    const key = toKeyAsString({ topicId, resourceId, contextId });
                    const stored = this.requireWorking().inbox.get(key);
                    if (
                        !stored ||
                        stored.status !== EntityStatus.RESERVED ||
                        stored.dequeueAudit.attempts !== attempts
                    ) return [];
                    this.requireWorking().inbox.set(key, {
                        ...stored,
                        status,
                        dequeueAudit: {
                            ...stored.dequeueAudit,
                            endTs: Temporal.Instant.fromEpochMilliseconds(completedAt.getTime()),
                            nextTs: undefined,
                        },
                    });
                    return [{ ri_row_id: 1n }];
                }
                throw new Error(`Unexpected raw transaction SQL in atomic test database: ${query}`);
            }) as unknown as PSqlTransactionSql;
            transaction.begin = async () => {
                throw new Error('Nested transaction');
            };
            this.activeTransaction = transaction;
            this.working = cloneState(this.state);
            try {
                const result = await write(transaction);
                this.state = this.working;
                return result;
            } finally {
                this.activeTransaction = undefined;
                this.working = undefined;
            }
        };
        this.sql = sql;
    }

    writeMutation(key: string, value: unknown): void {
        this.requireWorking().mutations.set(key, value);
    }

    writeOutbox(key: string, value: unknown): void {
        this.requireWorking().outbox.set(key, value);
    }

    reclaimFinalization(): ResourceEntry {
        const [key, entry] = [...this.state.inbox.entries()][0] ?? [];
        if (!key || !entry) throw new Error('Missing finalization entry');
        const reclaimed: ResourceEntry = {
            ...entry,
            dequeueAudit: {
                attempts: entry.dequeueAudit.attempts + 1,
                startTs: Temporal.Instant.fromEpochMilliseconds(NOW_EPOCH_MS),
                endTs: undefined,
                nextTs: undefined,
            },
        };
        this.state.inbox.set(key, reclaimed);
        return reclaimed;
    }

    private requireWorking(): AtomicState {
        if (!this.working) throw new Error('Write occurred without active transaction');
        return this.working;
    }
}

function createAtomicHarness(options: Readonly<{
    attempts?: number;
    entryResource?: string;
    entryTopicId?: string;
    failResultWrite?: boolean;
    loseReservation?: boolean;
    timing?: (event: RallarTimingEvent) => void;
}> = {}) {
    const baseEntry = createReservedEntry(options.attempts ?? 7);
    const entry = {
        ...baseEntry,
        key: {
            ...baseEntry.key,
            topicId: options.entryTopicId ?? baseEntry.key.topicId,
        },
        resource: options.entryResource ?? baseEntry.resource,
    };
    const database = new AtomicDatabase(entry, {
        failResultWrite: options.failResultWrite ?? false,
        loseReservation: options.loseReservation ?? false,
    });
    const queue = new InMemoryQueueBox();
    const reader = new InboxQueueReader(queue);
    const service = new AtomicAppInboxService(
        reader,
        {} as never,
        {} as never,
        database.sql,
        'server-1',
        'app-inbox.group-state',
        options.timing,
        {
            phaseTiming: true,
            nowEpochMs: () => NOW_EPOCH_MS,
        },
    );
    const enqueue = {
        type: AppInboxType.GROUP_CREATE,
        resourceId: entry.key.resourceId,
        contextId: entry.key.contextId,
        data: { requestId: entry.key.resourceId },
    } as const;
    const context: AppInboxMessageContext = {
        enqueue,
        message: {} as never,
        entry,
    };
    return { context, database, entry, service };
}

function toAtomicResultEntry(values: readonly unknown[]): ResourceEntry {
    const [
        resourceId,
        topicId,
        resource,
        typeId,
        status,
        contextId,
        ,
        createdBy,
        createdTs,
        expiryTs,
    ] = values;
    return {
        key: { resourceId, topicId, contextId } as Key,
        resource: resource as string,
        typeId: typeId as string,
        status: status as EntityStatus,
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdBy: createdBy as string,
            createdTs: Temporal.PlainDateTime.from(String(createdTs).replace(/Z$/u, '')),
            expiryTs: String(expiryTs).endsWith('Z')
                ? Temporal.Instant.from(expiryTs as string)
                : Temporal.PlainDateTime.from(expiryTs as string).toZonedDateTime('UTC')
                    .toInstant(),
        },
        dequeueAudit: { attempts: 0 },
    };
}

function toAtomicResultRow(entry: ResourceEntry) {
    return {
        ris_row_id: 1n,
        ris_resource_id: entry.key.resourceId,
        ris_topic_id: entry.key.topicId,
        ris_resource: entry.resource,
        ris_type_id: entry.typeId,
        ris_status: entry.status,
        fk_ext_bank_id: entry.key.contextId,
        system_date: entry.audit.createdTs.toPlainDate().toString(),
        created_by: entry.audit.createdBy,
        created_ts: entry.audit.createdTs.toString(),
        expire_ts: entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
    };
}

function createReservedEntry(attempts: number): ResourceEntry {
    const enqueue = {
        type: AppInboxType.GROUP_CREATE,
        resourceId: 'request-1',
        contextId: 'group-1',
        data: { requestId: 'request-1' },
    };
    return {
        key: {
            topicId: 'app-inbox.group-state',
            resourceId: 'request-1',
            contextId: 'group-1',
        },
        resource: JSON.stringify({
            payload: {
                typeId: AppInboxType.GROUP_CREATE,
                resource: JSON.stringify(enqueue),
            },
        }),
        typeId: EnqueuedType.APP_INBOX,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'server-1',
            createdTs: Temporal.PlainDateTime.from('2026-07-22T11:59:00'),
            expiryTs: Temporal.Instant.from('2026-07-23T00:00:00Z'),
        },
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            attempts,
            startTs: Temporal.Instant.fromEpochMilliseconds(NOW_EPOCH_MS),
        },
    };
}

function toPersistedAppInboxResource(
    options: Readonly<{
    outerType?: string;
    nestedType?: string;
    }>,
): string {
    const command = options.nestedType === undefined
        ? { data: { secret: 'nested-password' } }
        : { type: options.nestedType, data: { secret: 'nested-password' } };
    const payload = options.outerType === undefined
        ? { resource: JSON.stringify(command) }
        : { typeId: options.outerType, resource: JSON.stringify(command) };
    return JSON.stringify({ payload });
}

function toRecovery(
    entry: ResourceEntry,
    reservationAttempt: number,
): ResourceInboxRetryExhaustionRecovery {
    return {
        entry,
        processingAttempts: 20,
        reservationAttempt,
        lane: 'FINALIZATION' as never,
        classification: 'retryable',
        exhausted: true,
        failure: { source: 'finalization-recovery' },
        queueAgeMs: 60_000,
        dueAgeMs: 300_000,
        selectedDueAtEpochMs: NOW_EPOCH_MS - 300_000,
        finalizedAtEpochMs: NOW_EPOCH_MS,
    };
}

function toExhaustion(entry: ResourceEntry): ResourceInboxRetryExhaustion {
    return {
        entry,
        processingAttempts: 20,
        reservationAttempt: 20,
        lane: 'NEW' as never,
        classification: 'retryable',
        exhausted: true,
        failure: {
            source: 'processing',
            error: Object.assign(new Error('retryable conflict'), {
                code: 'runtime-state-write-conflict',
            }),
        },
        queueAgeMs: 60_000,
        dueAgeMs: 0,
        exhaustedAtEpochMs: NOW_EPOCH_MS,
    };
}

function cloneState(state: AtomicState): AtomicState {
    return {
        mutations: new Map(state.mutations),
        outbox: new Map(state.outbox),
        inbox: new Map(state.inbox),
        results: new Map(state.results),
    };
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        1,
        1,
        1,
    );
}
