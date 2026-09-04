import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';

import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { describe, expect, it } from 'vitest';
import {
    createRegisteredHandlerHarness,
    createResilience,
    toRegisteredHandlerIdentityResource,
    waitForRegisteredHandlerEntry
} from '../test-support/app-inbox-transaction-test-runtime.ts';

describe('AppInboxHandlerExecutor registered handler finalization', () => {
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
            let acceptedMutationExecutions = 0;
            const handler = async (_data: JsonWireValue, context: Parameters<typeof harness.service.commit>[0]) =>
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
            expect(acceptedMutationExecutions).toBe(valid ? 1 : 0);
        }
    );

    it('keeps mismatched identity out of the transaction mutation callback', async () => {
        const harness = createRegisteredHandlerHarness();
        let mutationCommitted = false;
        const handler = async (_data: JsonWireValue, context: Parameters<typeof harness.service.commit>[0]) =>
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
        expect((await harness.readEntry())?.status).toBe(EntityStatus.FAILED);
        expect((await harness.readEntry())?.dequeueAudit.attempts).toBe(1);
    });
});

function isJsonWireObject(value: JsonWireValue): value is Readonly<{
    readonly [key: string]: JsonWireValue;
}> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
