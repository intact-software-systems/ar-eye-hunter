import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    AppInboxReservationConflictError,
    AppInboxType,
    type AppInboxMessageContext
} from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { DEFAULT_APP_INBOX_ATTEMPT_DEADLINE_MARGIN_MS } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import { AppInboxReservationClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-reservation-client.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { AppInboxHandlerExecutor } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-executor.ts';
import type { AppInboxHandlerRegistration } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-registration.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { ResourceInboxHandlerEntryError } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createManualTimers } from '../../../../shared/resilience/manual-timers.ts';
import { TestResourceInboxResults } from '../test-support/app-inbox-resource-fixtures.ts';
import {
    createAtomicHarness,
    createRegisteredHandlerHarness,
    createResilience,
    toRegisteredHandlerIdentityResource,
    waitForRegisteredHandlerEntry
} from '../test-support/app-inbox-transaction-test-runtime.ts';
import { createAppInboxQueueMessageFixture } from '../test-support/create-app-inbox-queue-message-fixture.ts';

describe('AppInboxHandlerExecutor registered handler finalization', () => {
    it('redelivers a message with captured authority after a later conditional write conflicts', async () => {
        const timing: RallarTimingEvent[] = [];
        let now = Temporal.Instant.from('2000-01-01T00:00:00Z');
        const harness = createRegisteredHandlerHarness({ timing: (event) => timing.push(event), now: () => now });
        const reservations = new AppInboxReservationClient({
            creationNow: Temporal.Now.instant,
            createMessage: createAppInboxQueueMessageFixture,
            repository: harness.queue
        }, { serviceId: 'server-1' });
        const facts = { eventId: 'stable-event', observedAtEpochMs: 1234 };
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, async (_data, context) => {
            if (context.entry.dequeueAudit.attempts === 1) {
                const original = context.entry.resource;
                Object.freeze(context.entry);
                Object.freeze(context);
                const entry = await reservations.persistAuthority(context, facts);
                expect(context.entry.resource).toBe(original);
                throw new ResourceInboxHandlerEntryError(entry, new AppInboxReservationConflictError(entry.key));
            }
            return await harness.service.commit(context, context.enqueue.authority!, async () => {});
        });

        const pending = harness.service.enqueueAndWait(harness.enqueue);
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const retry = await harness.readEntry();
        expect(retry).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
        expect(retry?.dequeueAudit.startTs?.epochMilliseconds).toBe(now.epochMilliseconds);
        const nextTs = retry?.dequeueAudit.nextTs;
        if (nextTs === undefined) {
            throw new Error('A retry must persist its next eligible time');
        }
        now = nextTs;
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(pending).resolves.toMatchObject({ right: facts });
        expect(await harness.readEntry()).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 2 } });
        expect(timing).toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'queue-retry', details: expect.objectContaining({ errorCode: 'app-inbox-reservation-conflict' }) })
        ]));
    });

    it('hands a write conflict to the lane as a retryable value, not a thrown error with a stack', async () => {
        let now = Temporal.Instant.from('2000-01-01T00:00:00Z');
        const harness = createRegisteredHandlerHarness({ now: () => now });
        const reservations = new AppInboxReservationClient({
            creationNow: Temporal.Now.instant,
            createMessage: createAppInboxQueueMessageFixture,
            repository: harness.queue
        }, { serviceId: 'server-1' });
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, async (_data, context) => {
            if (context.entry.dequeueAudit.attempts === 1) {
                const entry = await reservations.persistAuthority(context, { eventId: 'stable-event' });
                throw new ResourceInboxHandlerEntryError(entry, new ResultReadConflictError());
            }
            return await harness.service.commit(context, { status: 'accepted' }, async () => {});
        });
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const pending = harness.service.enqueueAndWait(harness.enqueue);
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

            expect(errorLog).not.toHaveBeenCalled();
            expect(infoLog.mock.calls.filter(([message]) => String(message).includes('runtime-state-write-conflict'))).toHaveLength(1);
            const retry = await harness.readEntry();
            expect(retry).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
            expect(retry?.resource).toContain('stable-event');
            now = retry!.dequeueAudit.nextTs!;
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            await expect(pending).resolves.toMatchObject({ right: { status: 'accepted' } });
        }
        finally {
            errorLog.mockRestore();
            infoLog.mockRestore();
        }
    });

    it('preserves terminal rejection classification after authority is persisted', async () => {
        const harness = createRegisteredHandlerHarness();
        const reservations = new AppInboxReservationClient({
            creationNow: Temporal.Now.instant,
            createMessage: createAppInboxQueueMessageFixture,
            repository: harness.queue
        }, { serviceId: 'server-1' });
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, async (_data, context) => {
            const entry = await reservations.persistAuthority(context, { eventId: 'stable-event' });
            throw new ResourceInboxHandlerEntryError(entry, new TypeError('Malformed domain value'));
        });
        const pending = harness.service.enqueueAndWait(harness.enqueue);
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(pending).resolves.toMatchObject({ left: { code: 'app-inbox-malformed-command', status: 400 } });
        expect(await harness.readEntry()).toMatchObject({ status: EntityStatus.NON_RETRYABLE, dequeueAudit: { attempts: 1 } });
    });

    it('rejects startup when a configured handler has not been registered', () => {
        const harness = createRegisteredHandlerHarness();

        expect(() => harness.service.assertRegistrationComplete([AppInboxType.GROUP_CREATE])).toThrow('missing=GROUP_CREATE');

        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, async () => null);

        expect(() => harness.service.assertRegistrationComplete([AppInboxType.GROUP_CREATE])).not.toThrow();
    });

    it('skips duplicate result persistence after a transaction-owned commit', async () => {
        const timing: RallarTimingEvent[] = [];
        const harness = createRegisteredHandlerHarness({
            failResultWriteAfter: 1,
            timing: (event) => timing.push(event)
        });
        harness.service.onStateMessage(
            AppInboxType.GROUP_CREATE,
            async (_data, context) =>
                await harness.service.commit(
                    context,
                    { status: 'accepted', source: 'transaction' },
                    async () => {}
                )
        );

        const pending = harness.service.enqueueAndWait(harness.enqueue);
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
            await harness.service.commit(
                context,
                { status: 'accepted', source: 'transaction' },
                async () => {}
            );
            throw new Error('secret-after-commit');
        });

        const pending = harness.service.enqueueAndWait(harness.enqueue);
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
        harness.service.registerHandler({
            type: AppInboxType.GROUP_CREATE,
            decodeCommand: (value) => {
                if (!isJsonWireObject(value) || typeof value.requestId !== 'string') {
                    throw new TypeError('Group create command is invalid');
                }
                return { requestId: value.requestId };
            },
            encodeResult: (result) => ({ status: result.outcome, source: 'handler' }),
            handle: async () => ({ outcome: 'accepted' as const })
        });

        const pending = harness.service.enqueueAndWait(harness.enqueue);
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(pending).resolves.toMatchObject({
            right: { status: 'accepted', source: 'handler' }
        });
        expect(harness.results.replaceCalls).toBe(1);
    });

    it('rejects malformed domain commands before handler invocation', async () => {
        const harness = createRegisteredHandlerHarness();
        let domainMutationStarted = false;
        harness.service.registerHandler({
            type: AppInboxType.GROUP_CREATE,
            decodeCommand: () => {
                throw new TypeError('Group create command is invalid');
            },
            encodeResult: (result) => result,
            handle: async () => {
                domainMutationStarted = true;
                return { status: 'unexpected' as const };
            }
        });

        const pending = harness.service.enqueueAndWait(harness.enqueue);
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(pending).resolves.toMatchObject({
            left: { code: 'app-inbox-malformed-command', status: 400 }
        });
        expect(domainMutationStarted).toBe(false);
        expect(harness.results.replaceCalls).toBe(1);
    });

    it('classifies malformed handler JSON as terminal before handler invocation', async () => {
        const harness = createRegisteredHandlerHarness();
        let domainMutationStarted = false;
        const handler = async () => {
            domainMutationStarted = true;
            return { status: 'unexpected' };
        };
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, handler);
        harness.service.enqueueWithoutWaiting(harness.enqueue);
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

        expect(domainMutationStarted).toBe(false);
        expect((await harness.readEntry())?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect([...harness.results.entries.values()]).toEqual([
            expect.objectContaining({ status: EntityStatus.NON_RETRYABLE })
        ]);
    });

    it('returns a durable terminal failure to the waiting caller for corrupt outer JSON', async () => {
        const harness = createRegisteredHandlerHarness();
        const pending = harness.service.enqueueAndWait(harness.enqueue);
        const entry = await waitForRegisteredHandlerEntry(harness.queue);
        await harness.queue.enqueue({ ...entry, resource: '{"private-payload":' });

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(pending).resolves.toMatchObject({
            left: { code: 'app-inbox-malformed-command', status: 400, retry: null }
        });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect(await harness.readEntry()).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 1, nextTs: undefined }
        });
        const result = harness.results.entries.get(toKeyAsString(entry.key));
        expect(result?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect(result?.resource).not.toContain('private-payload');
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
            let acceptedMutationExecutions = 0;
            const handler = async (_data: JsonWireValue, context: AppInboxMessageContext<JsonWireValue>) =>
                await harness.service.commit(context, { status: 'accepted' }, async () => {
                    acceptedMutationExecutions += 1;
                });
            harness.service.onStateMessage(outerType as AppInboxType, handler);
            harness.service.enqueueWithoutWaiting(harness.enqueue);
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
                expect(acceptedMutationExecutions).toBe(1);
                expect(finalized.status).toBe(EntityStatus.COMPLETED);
                expect(result?.status).toBe(EntityStatus.COMPLETED);
            }
            else {
                expect(acceptedMutationExecutions).toBe(0);
                expect(finalized.status).toBe(EntityStatus.NON_RETRYABLE);
                expect(result?.status).toBe(EntityStatus.NON_RETRYABLE);
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
            expect(acceptedMutationExecutions).toBe(valid ? 1 : 0);
        }
    );

    it('keeps mismatched identity out of the transaction mutation callback', async () => {
        const harness = createRegisteredHandlerHarness();
        let mutationCommitted = false;
        const handler = async (_data: JsonWireValue, context: AppInboxMessageContext<JsonWireValue>) =>
            await harness.service.commit(context, { status: 'accepted' }, async () => {
                mutationCommitted = true;
            });
        harness.service.onStateMessage(AppInboxType.GROUP_UPDATE, handler);
        harness.service.enqueueWithoutWaiting(harness.enqueue);
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

        expect(mutationCommitted).toBe(false);
        expect((await harness.readEntry())?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect((await harness.readEntry())?.dequeueAudit.attempts).toBe(1);
    });
});

describe('AppInboxHandlerExecutor claim invariants', () => {
    it('refuses to complete a claim whose handler-finalized entry reads back as anything but COMPLETED', async () => {
        const claim = createDirectExecutorClaim(() => 1_000);
        const execution = claim.executor.execute({
            ...claim.input,
            registration: {
                ...claim.input.registration,
                handle: async (_command, context) => {
                    const completionInput = {
                        ...claim.writer.readCompletionFacts(context),
                        status: EntityStatus.COMPLETED,
                        durableResult: { status: 'accepted' }
                    } as const;
                    const completion = computeAppInboxCompletion(completionInput);
                    expect(validateAppInboxCompletion(completionInput, completion)).toEqual([]);
                    const result = await claim.writer.writeComputedMutation(context, completion, async () => {});
                    vi.spyOn(claim.writer, 'read').mockReturnValue({
                        state: 'transaction-finalized',
                        entry: { ...context.entry, status: EntityStatus.RESERVED }
                    });
                    return result;
                }
            }
        });

        await expect(execution).rejects.toThrow('must finalize it COMPLETED');
    });

    it.each([
        { handlerDurationMs: 60_000, outranLease: false },
        { handlerDurationMs: 60_001, outranLease: true }
    ])(
        'reports a handler of $handlerDurationMs ms against its 60 s reservation lease as outrunning it: $outranLease',
        async ({ handlerDurationMs, outranLease }) => {
            let nowEpochMs = 1_000;
            const claim = createDirectExecutorClaim(() => nowEpochMs);
            await claim.executor.execute({
                ...claim.input,
                registration: {
                    ...claim.input.registration,
                    handle: async () => {
                        nowEpochMs += handlerDurationMs;
                        return { status: 'accepted' };
                    }
                }
            });

            expect(claim.timing.filter((event) => event.operation === 'handler-outran-lease')).toEqual(
                outranLease
                    ? [expect.objectContaining({
                        component: 'app-inbox-handler',
                        status: 'error',
                        durationMs: handlerDurationMs,
                        details: expect.objectContaining({ reservationLeaseMs: 60_000, attempt: 7 })
                    })]
                    : []
            );
        }
    );
});

describe('AppInboxHandlerExecutor attempt deadline', () => {
    const LEASE_MS = 60_000;
    const DEADLINE_MS = LEASE_MS - DEFAULT_APP_INBOX_ATTEMPT_DEADLINE_MARGIN_MS;

    it('abandons a handler that never settles at its deadline below the reservation lease', async () => {
        const timers = createManualTimers(0);
        const claim = createDirectExecutorClaim(() => 1_000, timers);
        const started = createSignal();
        const execution = claim.executor.execute({
            ...claim.input,
            registration: {
                ...claim.input.registration,
                handle: () => {
                    started.resolve();
                    return new Promise<never>(() => undefined);
                }
            }
        });
        const outcome = execution.then(() => 'settled', (error: unknown) => error);
        await started.promise;

        await timers.advance(DEADLINE_MS - 1);
        expect(await readWithin(outcome, 50)).toBe('still running');
        await timers.advance(1);

        expect(await readWithin(outcome, 1_000)).toMatchObject({ code: 'app-inbox-attempt-deadline-exceeded' });
        expect(claim.timing).toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'handler-deadline-expired', details: expect.objectContaining({ deadlineMs: DEADLINE_MS }) })
        ]));
    });

    it('rolls back a handler write that reaches its transaction after the deadline', async () => {
        const timers = createManualTimers(0);
        const claim = createDirectExecutorClaim(() => 1_000, timers);
        const started = createSignal();
        const writeAllowed = createSignal();
        let lateWrite: Promise<JsonWireValue> | undefined;
        const execution = claim.executor.execute({
            ...claim.input,
            registration: {
                ...claim.input.registration,
                handle: async (_command, context) => {
                    started.resolve();
                    await writeAllowed.promise;
                    const completionInput = {
                        ...claim.writer.readCompletionFacts(context),
                        status: EntityStatus.COMPLETED,
                        durableResult: { status: 'accepted' }
                    } as const;
                    lateWrite = claim.writer.writeComputedMutation(
                        context,
                        computeAppInboxCompletion(completionInput),
                        async () => {}
                    );
                    return await lateWrite;
                }
            }
        });
        const outcome = execution.then(() => 'settled', (error: unknown) => error);
        await started.promise;

        await timers.advance(DEADLINE_MS);
        expect(await readWithin(outcome, 1_000)).toMatchObject({ code: 'app-inbox-attempt-deadline-exceeded' });
        writeAllowed.resolve();
        await vi.waitFor(() => expect(lateWrite).toBeDefined());

        await expect(lateWrite).rejects.toMatchObject({ code: 'app-inbox-attempt-deadline-exceeded' });
        expect(claim.harness.database.state.inbox.get(toKeyAsString(claim.harness.entry.key))?.status).toBe(
            EntityStatus.RESERVED
        );
        expect(claim.harness.database.state.results.size).toBe(0);
    });

    it('serves the lane past a never-settling handler and redelivers the entry on the retry path', async () => {
        const timers = createManualTimers(0);
        let now = Temporal.Instant.from('2000-01-01T00:00:00Z');
        const harness = createRegisteredHandlerHarness({ now: () => now, timers });
        const started = createSignal();
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, async (_data, context) => {
            if (context.entry.dequeueAudit.attempts === 1) {
                started.resolve();
                return await new Promise<never>(() => undefined);
            }
            return await harness.service.commit(context, { status: 'accepted' }, async () => {});
        });
        const pending = harness.service.enqueueAndWait(harness.enqueue);
        const firstPass = harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await started.promise;

        await timers.advance(ResourceInboxResilience.DEFAULT_RESERVATION_LEASE_MS);

        expect(await readWithin(firstPass.then(() => 'pass finished'), 1_000)).toBe('pass finished');
        const retry = await harness.readEntry();
        expect(retry).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
        now = retry!.dequeueAudit.nextTs!;
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await expect(pending).resolves.toMatchObject({ right: { status: 'accepted' } });
        expect(await harness.readEntry()).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 2 } });
    });
});

/** The group-state result read's optimistic conflict, as the lane sees it when a join's read raced a write. */
class ResultReadConflictError extends Error {
    readonly code = 'runtime-state-write-conflict';

    constructor() {
        super('Group state result read raced a write');
        this.name = 'ResultReadConflictError';
    }
}

interface Signal {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

function createSignal(): Signal {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

async function readWithin<T>(outcome: Promise<T>, waitMs: number): Promise<T | 'still running'> {
    return await Promise.race([
        outcome,
        new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), waitMs))
    ]);
}

interface DirectExecutorClaim {
    readonly harness: ReturnType<typeof createAtomicHarness>;
    readonly executor: AppInboxHandlerExecutor;
    readonly writer: AppInboxTransactionWriter;
    readonly timing: RallarTimingEvent[];
    readonly input: AppInboxHandlerExecutor.Input<JsonWireValue, JsonWireValue>;
}

function createDirectExecutorClaim(nowEpochMs: () => number, timers: Timers = createManualTimers(0)): DirectExecutorClaim {
    const harness = createAtomicHarness();
    const timing: RallarTimingEvent[] = [];
    const writer = new AppInboxTransactionWriter(
        { database: harness.database.sql, nowEpochMs },
        { serviceId: 'server-1' }
    );
    const executor = new AppInboxHandlerExecutor(
        {
            resultRepository: new TestResourceInboxResults(),
            transactionWriter: writer,
            database: harness.database.sql,
            nowEpochMs,
            timers
        },
        {
            serviceId: 'server-1',
            timing: (event) => timing.push(event),
            attemptDeadlineMarginMs: DEFAULT_APP_INBOX_ATTEMPT_DEADLINE_MARGIN_MS
        }
    );
    const registration: AppInboxHandlerRegistration<JsonWireValue, JsonWireValue> = {
        type: AppInboxType.GROUP_CREATE,
        decodeCommand: (value) => value,
        encodeResult: (result) => result,
        handle: async () => null
    };
    return {
        harness,
        executor,
        writer,
        timing,
        input: {
            registration,
            message: harness.context.message,
            entry: harness.entry,
            attemptTelemetry: { ...harness.context.attemptTelemetry, reservationLeaseMs: 60_000 }
        }
    };
}

function isJsonWireObject(value: JsonWireValue): value is Readonly<{
    readonly [key: string]: JsonWireValue;
}> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
