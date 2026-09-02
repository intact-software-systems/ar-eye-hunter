import { Temporal } from '@js-temporal/polyfill';
import { toTerminalAppInboxFailure, type AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed,
    type AppInboxCompletionInput
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { AppInboxHandlerExecutor } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-executor.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { ResourceInboxFinalizedByHandlerError } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it, vi } from 'vitest';
import { createAtomicHarness } from '../test-support/app-inbox-transaction-test-runtime.ts';

describe('AppInbox terminal failure computation', () => {
    it('computes the failure row, reservation CAS and queue outcome from explicit facts', () => {
        const input = createFailureInput();
        const first = computeAppInboxCompletion(input);
        const second = computeAppInboxCompletion(input);

        expect(first).toEqual(second);
        expect(validateAppInboxCompletion(input, first)).toEqual([]);
        expect(first.resultReplacement).toEqual({
            resourceId: input.entry.key.resourceId,
            topicId: input.entry.key.topicId,
            contextId: input.entry.key.contextId,
            typeId: input.entry.typeId,
            status: EntityStatus.FAILED,
            resource: JSON.stringify(input.durableResult),
            systemDate: '2026-07-22',
            createdBy: 'server-1',
            createdAt: '2026-07-22T11:59:00Z',
            expiresAt: '2026-07-23T00:00:00Z'
        });
        expect(first.reservationFinish).toEqual({
            key: input.entry.key,
            expectedAttempts: 7,
            status: EntityStatus.FAILED,
            completedAt: new Date(input.completedAtEpochMs)
        });
        expect(first.finalizedEntry.dequeueAudit.endTs?.epochMilliseconds).toBe(input.completedAtEpochMs);
        expect(first.finalizedEntry.dequeueAudit.nextTs).toBeUndefined();
        expect(input.entry.status).toBe(EntityStatus.RESERVED);
        expect(input.entry.dequeueAudit.endTs).toBeUndefined();
    });

    it('collects independent persistence mismatches without replacing the candidate', () => {
        const input = createFailureInput();
        const computed = computeAppInboxCompletion(input);
        const altered: AppInboxCompletionComputed<AppInboxFailure> = {
            ...computed,
            resultReplacement: { ...computed.resultReplacement, resource: '{}', expiresAt: 'wrong' },
            reservationFinish: { ...computed.reservationFinish, expectedAttempts: 8 },
            finalizedEntry: { ...computed.finalizedEntry, status: EntityStatus.COMPLETED }
        };

        expect(validateAppInboxCompletion(input, altered).map((issue) => issue.path)).toEqual([
            'computed.resultReplacement.resource',
            'computed.resultReplacement.expiresAt',
            'computed.reservationFinish.expectedAttempts',
            'computed.finalizedEntry.status'
        ]);
        expect(altered.resultReplacement.resource).toBe('{}');
    });

    it('reports invalid completion and reservation facts together without throwing', () => {
        const input = createFailureInput();
        const computed = computeAppInboxCompletion(input);
        const invalid: AppInboxCompletionInput<AppInboxFailure> = {
            ...input,
            completedAtEpochMs: Number.NaN,
            entry: { ...input.entry, status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } }
        };

        expect(validateAppInboxCompletion(invalid, computed).map((issue) => issue.path)).toEqual([
            'completedAtEpochMs',
            'entry.dequeueAudit.attempts',
            'entry.status'
        ]);
    });

    it('computes and validates without reading ambient clocks', () => {
        const input = createFailureInput();
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
            throw new Error('Ambient clock read');
        });
        const instant = vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => {
            throw new Error('Ambient instant read');
        });
        try {
            const computed = computeAppInboxCompletion(input);
            expect(validateAppInboxCompletion(input, computed)).toEqual([]);
        }
        finally {
            clock.mockRestore();
            instant.mockRestore();
        }
    });

    it('validates both completion timestamps and the encoded failure independently', () => {
        const input = createFailureInput();
        const computed = computeAppInboxCompletion(input);
        const altered: AppInboxCompletionComputed<AppInboxFailure> = {
            ...computed,
            encodedResult: null,
            reservationFinish: { ...computed.reservationFinish, completedAt: new Date(input.completedAtEpochMs + 1) },
            finalizedEntry: {
                ...computed.finalizedEntry,
                dequeueAudit: {
                    ...computed.finalizedEntry.dequeueAudit,
                    endTs: Temporal.Instant.fromEpochMilliseconds(input.completedAtEpochMs + 2)
                }
            }
        };

        expect(validateAppInboxCompletion(input, altered).map((issue) => issue.path)).toEqual([
            'computed.encodedResult',
            'computed.reservationFinish.completedAt',
            'computed.finalizedEntry.dequeueAudit.endTs'
        ]);
    });

    it('rejects an accessor without invoking it during validation', () => {
        const input = createFailureInput();
        const computed = computeAppInboxCompletion(input);
        let accessorReads = 0;
        const accessor = () => {
            accessorReads += 1;
            return 'side effect';
        };
        Object.defineProperty(computed.resultReplacement, 'resource', { enumerable: true, get: accessor });

        expect(validateAppInboxCompletion(input, computed)).toEqual([
            expect.objectContaining({ path: 'computed.resultReplacement.resource' })
        ]);
        expect(accessorReads).toBe(0);
    });

    it('accepts value-equivalent copied queue metadata and native timestamps', () => {
        const input = createFailureInput();
        const computed = computeAppInboxCompletion(input);
        const copied: AppInboxCompletionComputed<AppInboxFailure> = {
            ...computed,
            reservationFinish: {
                ...computed.reservationFinish,
                key: { ...computed.reservationFinish.key },
                completedAt: new Date(input.completedAtEpochMs)
            },
            finalizedEntry: {
                ...computed.finalizedEntry,
                key: { ...computed.finalizedEntry.key },
                dequeueAudit: {
                    ...computed.finalizedEntry.dequeueAudit,
                    endTs: Temporal.Instant.fromEpochMilliseconds(input.completedAtEpochMs)
                }
            }
        };

        expect(validateAppInboxCompletion(input, copied)).toEqual([]);
    });

    it('does not execute coercion on a counterfeit Temporal value', () => {
        const input = createFailureInput();
        const computed = computeAppInboxCompletion(input);
        let coercions = 0;
        const coerce = () => {
            coercions += 1;
            return '2026-07-22T12:00:01Z';
        };
        const counterfeit = Object.create(Temporal.Instant.prototype, {
            [Symbol.toPrimitive]: { value: coerce }
        }) as Temporal.Instant;
        const altered: AppInboxCompletionComputed<AppInboxFailure> = {
            ...computed,
            finalizedEntry: {
                ...computed.finalizedEntry,
                dequeueAudit: { ...computed.finalizedEntry.dequeueAudit, endTs: counterfeit }
            }
        };

        expect(validateAppInboxCompletion(input, altered).length).toBeGreaterThan(0);
        expect(coercions).toBe(0);
    });

    it.each(['createdTs', 'date'] as const)('does not read fields from a counterfeit audit %s', (field) => {
        const input = createFailureInput();
        const computed = computeAppInboxCompletion(input);
        let fieldReads = 0;
        const getter = () => {
            fieldReads += 1;
            throw new Error('Candidate getter executed');
        };
        const counterfeit = field === 'createdTs'
            ? Object.create(Temporal.PlainDateTime.prototype, { calendar: { get: getter } })
            : Object.create(Temporal.PlainTime.prototype, { hour: { get: getter } });
        const altered: AppInboxCompletionComputed<AppInboxFailure> = {
            ...computed,
            finalizedEntry: {
                ...computed.finalizedEntry,
                audit: { ...computed.finalizedEntry.audit, [field]: counterfeit }
            }
        };

        expect(validateAppInboxCompletion(input, altered).length).toBeGreaterThan(0);
        expect(fieldReads).toBe(0);
    });

    it('collects an uninspectable candidate and continues checking independent fields', () => {
        const input = createFailureInput();
        const computed = computeAppInboxCompletion(input);
        const altered: AppInboxCompletionComputed<AppInboxFailure> = {
            ...computed,
            resultReplacement: new Proxy(computed.resultReplacement, {
                ownKeys: () => {
                    throw new Error('Uninspectable candidate');
                }
            }),
            reservationFinish: { ...computed.reservationFinish, expectedAttempts: 8 }
        };

        expect(validateAppInboxCompletion(input, altered).map((issue) => issue.path)).toEqual([
            'computed.resultReplacement',
            'computed.reservationFinish.expectedAttempts'
        ]);
    });

    it('does not read clocks or serialize the failure in the writer', async () => {
        const harness = createAtomicHarness();
        const input = createFailureInput(harness.entry);
        const computed = computeAppInboxCompletion(input);
        expect(validateAppInboxCompletion(input, computed)).toEqual([]);
        const clock = vi.fn(() => {
            throw new Error('Completion clock read after compute');
        });
        const writer = new AppInboxTransactionWriter(
            { database: harness.database.sql },
            { serviceId: 'server-1', nowEpochMs: clock }
        );
        const serialize = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
            throw new Error('Failure serialization ran in write');
        });
        try {
            await writer.writeTerminalFailure(harness.context, computed);
        }
        finally {
            serialize.mockRestore();
        }
        const key = toKeyAsString(input.entry.key);
        expect(JSON.parse(harness.database.state.results.get(key)!.resource)).toEqual(input.durableResult);
        expect(harness.database.state.inbox.get(key)?.dequeueAudit.endTs?.epochMilliseconds).toBe(input.completedAtEpochMs);
        expect(harness.database.beginCalls).toBe(1);
    });

    it('rolls the failure result back on reservation loss without inner retry or key serialization', async () => {
        const harness = createAtomicHarness({ loseReservation: true });
        const input = createFailureInput(harness.entry);
        const computed = computeAppInboxCompletion(input);
        const writer = new AppInboxTransactionWriter({ database: harness.database.sql }, { serviceId: 'server-1' });
        expect(validateAppInboxCompletion(input, computed)).toEqual([]);
        const serialize = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
            throw new Error('Reservation-loss write serialized a key');
        });
        try {
            await expect(writer.writeTerminalFailure(harness.context, computed)).rejects.toBe(computed.reservationConflict);
        }
        finally {
            serialize.mockRestore();
        }

        expect(harness.database.state.results.size).toBe(0);
        expect(harness.database.state.inbox.get(toKeyAsString(input.entry.key))?.status).toBe(EntityStatus.RESERVED);
        expect(harness.database.beginCalls).toBe(1);
        expect(writer.read(harness.context)).toEqual({ state: 'pending' });
    });

    it('leaves the reserved entry and finalization state unchanged when result persistence fails', async () => {
        const harness = createAtomicHarness({ failResultWrite: true });
        const input = createFailureInput(harness.entry);
        const computed = computeAppInboxCompletion(input);
        const writer = new AppInboxTransactionWriter({ database: harness.database.sql }, { serviceId: 'server-1' });

        await expect(writer.writeTerminalFailure(harness.context, computed)).rejects.toThrow('result write failed');

        expect(harness.database.state.results.size).toBe(0);
        expect(harness.database.state.inbox.get(toKeyAsString(input.entry.key))?.status).toBe(EntityStatus.RESERVED);
        expect(harness.database.beginCalls).toBe(1);
        expect(writer.read(harness.context)).toEqual({ state: 'pending' });
    });

    it('uses one completion fact for both persisted state and the executor queue outcome', async () => {
        const harness = createAtomicHarness();
        const input = createFailureInput(harness.entry);
        let completionClockReads = 0;
        const nowEpochMs = () => {
            completionClockReads += 1;
            return input.completedAtEpochMs;
        };
        const writerClock = () => {
            throw new Error('Writer must not capture completion facts');
        };
        const writer = new AppInboxTransactionWriter(
            { database: harness.database.sql },
            { serviceId: 'server-1', nowEpochMs: writerClock }
        );
        const executor = new AppInboxHandlerExecutor({
            transactionWriter: writer,
            resultRepository: {
                replace: async () => {
                    throw new Error('Terminal failures must finalize atomically');
                },
                findByKey: async () => undefined
            }
        }, { serviceId: 'server-1', options: { nowEpochMs } });
        const rejected = new TypeError('Rejected command');
        const execution = executor.execute(
            {
                type: harness.context.enqueue.type,
                decodeCommand: () => null,
                encodeResult: () => null,
                handle: async () => {
                    throw rejected;
                }
            },
            harness.context.message,
            harness.entry
        );

        await expect(execution).rejects.toBeInstanceOf(ResourceInboxFinalizedByHandlerError);
        await expect(execution).rejects.toMatchObject({
            handlerError: rejected,
            entry: { status: EntityStatus.FAILED, dequeueAudit: { endTs: Temporal.Instant.fromEpochMilliseconds(input.completedAtEpochMs) } }
        });
        expect(completionClockReads).toBe(1);
        expect(harness.database.state.inbox.get(toKeyAsString(input.entry.key))?.dequeueAudit.endTs?.epochMilliseconds).toBe(input.completedAtEpochMs);
        expect(harness.database.beginCalls).toBe(1);
    });
});

function createFailureInput(entry = createAtomicHarness().entry): AppInboxCompletionInput<AppInboxFailure> {
    return {
        entry,
        completedAtEpochMs: Date.parse('2026-07-22T12:00:01.000Z'),
        status: EntityStatus.FAILED,
        durableResult: toTerminalAppInboxFailure({
            code: 'group-mutation-rejected',
            status: 400,
            message: 'The mutation was rejected'
        })
    };
}
