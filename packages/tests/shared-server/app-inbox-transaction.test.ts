import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';

import { readPersistedAppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { AppInboxReservationConflictError, AppInboxType, classifyAppInboxError } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';

import { GroupMutationAuthorizationError } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';

import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

import { GroupTopologyConfigValidationError } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { describe, expect, it, vi } from 'vitest';

const NOW_EPOCH_MS = Date.parse('2026-07-22T12:00:00.000Z');

import {
    createAtomicHarness,
    createRegisteredHandlerHarness,
    createResilience,
    toRegisteredHandlerIdentityResource,
    waitForRegisteredHandlerEntry
} from './app-inbox-transaction-test-runtime.ts';

describe('AppInboxHandlerRegistry transaction ownership', () => {
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
            JSON.parse(harness.database.state.results.get(toKeyAsString(harness.entry.key))!.resource)
        ).toEqual(receipt);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
            EntityStatus.COMPLETED
        );
    });

    it.each(['dependent-write', 'outbox-write'] as const)(
        'rolls the mutation back when the %s fails',
        async (failurePhase) => {
            const harness = createAtomicHarness();

            await expect(
                harness.service.commit(harness.context, async () => {
                    harness.database.writeMutation('group-1', { revision: 2 });
                    if (failurePhase === 'dependent-write') {
                        throw new Error('dependent write failed');
                    }
                    harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
                    throw new Error('outbox write failed');
                })
            ).rejects.toThrow(`${failurePhase.split('-')[0]} write failed`);

            expect(harness.database.state.mutations.size).toBe(0);
            expect(harness.database.state.outbox.size).toBe(0);
            expect(harness.database.state.results.size).toBe(0);
            expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
                EntityStatus.RESERVED
            );
        }
    );

    it('rolls every successful write back when the result write fails', async () => {
        const harness = createAtomicHarness({ failResultWrite: true });

        await expect(
            harness.service.commit(harness.context, async () => {
                harness.database.writeMutation('group-1', { revision: 2 });
                harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
                return { status: 'accepted' };
            })
        ).rejects.toThrow('result write failed');

        expect(harness.database.state.mutations.size).toBe(0);
        expect(harness.database.state.outbox.size).toBe(0);
        expect(harness.database.state.results.size).toBe(0);
    });

    it('rolls every successful write back when reservation ownership changed', async () => {
        const harness = createAtomicHarness({ loseReservation: true });

        await expect(
            harness.service.commit(harness.context, async () => {
                harness.database.writeMutation('group-1', { revision: 2 });
                harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
                return { status: 'accepted' };
            })
        ).rejects.toBeInstanceOf(AppInboxReservationConflictError);
        await expect(
            harness.service.commit(harness.context, async () => undefined)
        ).rejects.toMatchObject({ code: 'app-inbox-reservation-conflict' });

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
            details: { groupId: 'group-1' }
        });

        const classification = classifyAppInboxError(denial);
        expect(classification).toMatchObject({ kind: 'terminal' });
        if (classification.kind !== 'terminal') {
            throw new Error('Expected terminal denial');
        }
        const failure: JsonWireValue = JSON.parse(JSON.stringify(classification.result));
        await harness.service.fail(harness.context, failure);

        const stored = harness.database.state.results.get(toKeyAsString(harness.entry.key));
        expect(stored?.status).toBe(EntityStatus.FAILED);
        expect(JSON.parse(stored!.resource)).toMatchObject({
            code: 'group-policy-denied',
            message: 'membership is required'
        });
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
            EntityStatus.FAILED
        );
    });

    it('classifies CAS conflicts as retryable without writing a result', async () => {
        const harness = createAtomicHarness();
        const conflict = Object.assign(new Error('conditional write lost'), {
            code: 'runtime-state-write-conflict',
            status: 503
        });

        expect(classifyAppInboxError(conflict)).toEqual({
            kind: 'retryable',
            code: 'runtime-state-write-conflict',
            message: 'AppInbox processing encountered a retryable conflict'
        });
        expect(harness.database.state.results.size).toBe(0);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
            EntityStatus.RESERVED
        );

        expect(
            classifyAppInboxError(new AppInboxReservationConflictError(harness.entry.key))
        ).toMatchObject({
            kind: 'retryable',
            code: 'app-inbox-reservation-conflict'
        });
    });

    it('records transaction and write timing for the winning attempt', async () => {
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

describe('AppInboxHandlerRegistry registered handler finalization', () => {
    it('skips duplicate result persistence after a transaction-owned commit', async () => {
        const timing: RallarTimingEvent[] = [];
        const harness = createRegisteredHandlerHarness({
            failResultWriteAfter: 1,
            timing: (event) => timing.push(event)
        });
        harness.service.onStateMessage(
            AppInboxType.GROUP_CREATE,
            async (_data, context) =>
                await harness.service.commit(context, async () => ({
                    status: 'accepted',
                    source: 'transaction'
                }))
        );

        const pending = harness.service.processEntryUntilCompletion(harness.enqueue);
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(pending).resolves.toMatchObject({
            right: { status: 'accepted', source: 'transaction' }
        });
        expect(harness.results.replaceCalls).toBe(1);
        expect((await harness.readEntry())?.status).toBe(EntityStatus.COMPLETED);
        expect(timing).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ operation: 'queue-retry' })])
        );
    });

    it('returns the committed result after a post-finalization handler error', async () => {
        const timing: RallarTimingEvent[] = [];
        const harness = createRegisteredHandlerHarness({
            timing: (event) => timing.push(event)
        });
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, async (_data, context) => {
            await harness.service.commit(context, async () => ({
                status: 'accepted',
                source: 'transaction'
            }));
            throw new Error('secret-after-commit');
        });

        const pending = harness.service.processEntryUntilCompletion(harness.enqueue);
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(pending).resolves.toMatchObject({
            right: { status: 'accepted', source: 'transaction' }
        });
        expect(harness.results.replaceCalls).toBe(1);
        expect(timing).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ operation: 'queue-retry' })])
        );
    });

    it('persists a non-transactional handler result exactly once', async () => {
        const harness = createRegisteredHandlerHarness();
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, async () => ({
            status: 'accepted',
            source: 'handler'
        }));

        const pending = harness.service.processEntryUntilCompletion(harness.enqueue);
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(pending).resolves.toMatchObject({
            right: { status: 'accepted', source: 'handler' }
        });
        expect(harness.results.replaceCalls).toBe(1);
    });

    it('classifies malformed handler JSON as terminal before handler invocation', async () => {
        const harness = createRegisteredHandlerHarness();
        const handler = vi.fn(async () => ({ status: 'unexpected' }));
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, handler);
        harness.service.processEntryNoWaiting(harness.enqueue);
        const entry = await waitForRegisteredHandlerEntry(harness.queue);
        const message = JSON.parse(entry.resource) as {
            payload: { resource: string; };
        };
        message.payload.resource = '{"malformed":';
        await harness.queue.enqueue({
            ...entry,
            resource: JSON.stringify(message)
        });

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect(handler).not.toHaveBeenCalled();
        expect((await harness.readEntry())?.status).toBe(EntityStatus.FAILED);
        expect([...harness.results.entries.values()]).toEqual([
            expect.objectContaining({ status: EntityStatus.FAILED })
        ]);
    });

    it.each(
        [
            {
                name: 'known outer and nested mismatch',
                outerType: AppInboxType.GROUP_UPDATE as string,
                nested: { kind: 'operation' as const, type: AppInboxType.GROUP_CREATE as string },
                topicId: 'app-inbox.group-state',
                valid: false
            },
            {
                name: 'missing nested type',
                outerType: AppInboxType.GROUP_CREATE as string,
                nested: { kind: 'missing' as const },
                topicId: 'app-inbox.group-state',
                valid: false
            },
            {
                name: 'unknown removed nested type',
                outerType: AppInboxType.GROUP_CREATE as string,
                nested: { kind: 'operation' as const, type: 'REMOVED_GROUP_password' },
                topicId: 'app-inbox.group-state',
                valid: false
            },
            {
                name: 'unknown removed outer type with a registered callback',
                outerType: 'REMOVED_GROUP_password',
                nested: { kind: 'operation' as const, type: 'REMOVED_GROUP_password' },
                topicId: 'app-inbox.group-state',
                valid: false
            },
            {
                name: 'wrong durable queue topic',
                outerType: AppInboxType.GROUP_CREATE as string,
                nested: { kind: 'operation' as const, type: AppInboxType.GROUP_CREATE as string },
                topicId: 'app-inbox.client-state',
                valid: false
            },
            {
                name: 'corrupt nested JSON',
                outerType: AppInboxType.GROUP_CREATE as string,
                nested: { kind: 'corrupt' as const },
                topicId: 'app-inbox.group-state',
                valid: false
            },
            {
                name: 'valid group exact-operation durable topic',
                outerType: AppInboxType.GROUP_CREATE as string,
                nested: { kind: 'operation' as const, type: AppInboxType.GROUP_CREATE as string },
                topicId: AppInboxType.GROUP_CREATE as string,
                valid: true
            },
            {
                name: 'valid client exact-operation durable topic',
                outerType: AppInboxType.CLIENT_SESSION_CONNECT as string,
                nested: {
                    kind: 'operation' as const,
                    type: AppInboxType.CLIENT_SESSION_CONNECT as string
                },
                topicId: AppInboxType.CLIENT_SESSION_CONNECT as string,
                valid: true
            },
            {
                name: 'valid outer nested and topic agreement',
                outerType: AppInboxType.GROUP_CREATE as string,
                nested: { kind: 'operation' as const, type: AppInboxType.GROUP_CREATE as string },
                topicId: 'app-inbox.group-state',
                valid: true
            },
            {
                name: 'valid operation-specific durable topic agreement',
                outerType: AppInboxType.CLIENT_EXPIRED_SESSIONS as string,
                nested: {
                    kind: 'operation' as const,
                    type: AppInboxType.CLIENT_EXPIRED_SESSIONS as string
                },
                topicId: AppInboxType.CLIENT_EXPIRED_SESSIONS as string,
                valid: true
            }
        ].flatMap((testCase) => [
            { ...testCase, attempt: 1 },
            { ...testCase, attempt: 19 }
        ])
    )(
        'validates $name before attempt $attempt handler dispatch',
        async ({ outerType, nested, topicId, valid, attempt }) => {
            const timing: RallarTimingEvent[] = [];
            const harness = createRegisteredHandlerHarness({
                timing: (event) => timing.push(event),
                topicId
            });
            let mutationCommitted = false;
            const handler = vi.fn(
                async (_data, context) =>
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
                dequeueAudit: { attempts: attempt - 1 }
            });

            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            const finalized = await harness.readEntry();
            expect(finalized).toBeDefined();
            if (!finalized) {
                throw new Error('Expected finalized AppInbox entry');
            }
            const result = harness.results.entries.get(toKeyAsString(finalized.key));

            expect(finalized.dequeueAudit.attempts).toBe(attempt);
            expect(finalized.dequeueAudit.nextTs).toBeUndefined();
            if (valid) {
                expect(handler).toHaveBeenCalledTimes(1);
                expect(mutationCommitted).toBe(true);
                expect(finalized.status).toBe(EntityStatus.COMPLETED);
                expect(result?.status).toBe(EntityStatus.COMPLETED);
            }
            else {
                expect(handler).not.toHaveBeenCalled();
                expect(mutationCommitted).toBe(false);
                expect(finalized.status).toBe(EntityStatus.FAILED);
                expect(result?.status).toBe(EntityStatus.FAILED);
                expect(JSON.parse(result!.resource)).toMatchObject({
                    code: 'app-inbox-malformed-command',
                    status: 400
                });
                expect(result?.resource).not.toContain('password');
            }
            expect(timing).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ operation: 'queue-retry' })])
            );

            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            expect((await harness.readEntry())?.dequeueAudit.attempts).toBe(attempt);
            expect(handler).toHaveBeenCalledTimes(valid ? 1 : 0);
        }
    );

    it('keeps mismatched identity out of the transaction mutation callback', async () => {
        const harness = createRegisteredHandlerHarness();
        let mutationCommitted = false;
        const handler = vi.fn(
            async (_data, context) =>
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
                    type: AppInboxType.GROUP_CREATE
                }
            })
        });

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect(handler).not.toHaveBeenCalled();
        expect(mutationCommitted).toBe(false);
        expect((await harness.readEntry())?.status).toBe(EntityStatus.FAILED);
        expect((await harness.readEntry())?.dequeueAudit.attempts).toBe(1);
    });
});

describe('AppInbox error classification', () => {
    it('fails closed when persisted failure metadata is structurally corrupt', () => {
        const malformed = readPersistedAppInboxFailure(
            JSON.stringify({
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
                    dueAgeMs: 5
                },
                commandIdentity: {
                    contextId: '',
                    resourceId: 'request-1',
                    topicId: 'app-inbox.group-state',
                    operation: 'TOPOLOGY_CONFIG_PUT',
                    operationSource: 'command'
                },
                selectedLane: 'NEW',
                processingAttempts: 20,
                reservationAttempt: 20,
                lastError: {
                    source: 'processing',
                    code: 'runtime-state-write-conflict',
                    message: 'retryable conflict'
                },
                queueAgeMs: 10,
                dueAgeMs: 5,
                exhaustedAtEpochMs: NOW_EPOCH_MS
            })
        );

        expect(malformed).toEqual({
            type: 'app-inbox-failure',
            version: 'malformed.v0',
            code: 'app-inbox-malformed-persisted-failure',
            status: 500,
            message: 'Persisted AppInbox failure is malformed',
            issues: null,
            denial: null,
            retry: null
        });
    });

    it('serializes validation and authority failures with mandatory structured fields', () => {
        const validation = classifyAppInboxError(
            new GroupTopologyConfigValidationError([
                {
                    code: 'invalid-positive-integer',
                    path: ['degreeLimit'],
                    message: 'degreeLimit must be a positive integer',
                    details: { value: 0 }
                }
            ])
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
                issues: [
                    {
                        code: 'invalid-positive-integer',
                        path: ['degreeLimit'],
                        message: 'degreeLimit must be a positive integer',
                        details: { value: 0 }
                    }
                ],
                denial: null,
                retry: null
            }
        });

        const authority = classifyAppInboxError(
            new GroupMutationAuthorizationError('session was revoked')
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
                    details: null
                },
                retry: null
            }
        });
    });

    it.each([
        {
            name: 'typed reservation conflict with 409',
            error: Object.assign(new Error('reservation changed'), {
                code: 'app-inbox-reservation-conflict',
                status: 409
            }),
            kind: 'retryable'
        },
        {
            name: 'typed CAS conflict with 409',
            error: Object.assign(new Error('predecessor changed'), {
                code: 'runtime-state-write-conflict',
                status: 409
            }),
            kind: 'retryable'
        },
        {
            name: 'typed transient error',
            error: Object.assign(new Error('database unavailable'), {
                code: 'app-inbox-transient',
                status: 503
            }),
            kind: 'retryable'
        },
        {
            name: 'authorization denial',
            error: Object.assign(new Error('forbidden'), {
                code: 'group-mutation-authority-denied',
                status: 403
            }),
            kind: 'terminal'
        },
        {
            name: 'malformed command with non-4xx status',
            error: Object.assign(new Error('invalid command'), {
                code: 'app-inbox-malformed-command',
                status: 503
            }),
            kind: 'terminal'
        },
        {
            name: 'invariant corruption with non-4xx status',
            error: Object.assign(new Error('corrupt state'), {
                code: 'resource-inbox-invariant-corruption',
                status: 503
            }),
            kind: 'terminal'
        },
        {
            name: 'lifecycle rejection with non-4xx status',
            error: Object.assign(new Error('expired lifecycle'), {
                code: 'app-inbox-lifecycle-rejected',
                status: 503
            }),
            kind: 'terminal'
        },
        {
            name: 'syntax decoding failure',
            error: new SyntaxError('unexpected token secret'),
            kind: 'terminal'
        },
        {
            name: 'type decoding failure',
            error: new TypeError('invalid persisted shape secret'),
            kind: 'terminal'
        },
        {
            name: 'unknown error',
            error: new Error('unknown failure'),
            kind: 'retryable'
        },
        ...[
            'future-validation-timeout',
            'network-collision-course',
            'transient-invariant-corruption-wrapper',
            'authority-denied-by-upstream-ish',
            'policy-denied-retry-proxy',
            'lifecycle-rejected-temporarily'
        ].map((code) => ({
            name: `unknown fragment-bearing code ${code}`,
            error: Object.assign(new Error('unknown transient failure'), { code }),
            kind: 'retryable' as const
        })),
        {
            name: 'known idempotency conflict',
            error: Object.assign(new Error('command identity changed'), {
                code: 'app-inbox-idempotency-conflict',
                status: 409
            }),
            kind: 'terminal'
        },
        {
            name: 'known mutation rejection',
            error: Object.assign(new Error('mutation rejected'), {
                code: 'group-mutation-rejected',
                status: 409
            }),
            kind: 'terminal'
        }
    ])('classifies $name by typed code precedence', ({ error, kind }) => {
        expect(classifyAppInboxError(error).kind).toBe(kind);
    });
});
