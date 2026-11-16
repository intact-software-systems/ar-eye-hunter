import type * as Playwright from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import { closeParticipantContext, PAGE_CLOSE_TIMEOUT_MS } from '../../../tests/playwright/rallar-black-box/close-participant-context.ts';

describe('closing a participant whose page cleanup may never settle', () => {
    function createParticipant(events: string[]): Parameters<typeof closeParticipantContext>[0] {
        return {
            page: {} as Playwright.Page,
            context: {
                close: async () => {
                    events.push('close');
                }
            } as Playwright.BrowserContext
        };
    }

    it('closes the context after a cleanup that settles', async () => {
        const events: string[] = [];

        await closeParticipantContext(createParticipant(events), async () => {
            events.push('cleanup');
        });

        expect(events).toEqual(['cleanup', 'close']);
    });

    it('closes the context when the cleanup never settles, and reports it after the close', async () => {
        vi.useFakeTimers();
        try {
            const events: string[] = [];
            const closing = closeParticipantContext(createParticipant(events), () => new Promise<void>(() => {}))
                .then(() => undefined, (error: Error) => error);

            await vi.advanceTimersByTimeAsync(PAGE_CLOSE_TIMEOUT_MS - 1);
            expect(events).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            const reported = await closing;

            expect(events).toEqual(['close']);
            expect(reported).toBeInstanceOf(Error);
            expect((reported as Error).message).toBe(`The page cleanup did not settle within ${PAGE_CLOSE_TIMEOUT_MS} ms; its context was closed.`);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('reports both failures when the cleanup failed and the close then failed', async () => {
        const cleanupFailure = new Error('the cleanup failed');
        const closeFailure = new Error('the close failed');
        const participant = {
            page: {} as Playwright.Page,
            context: { close: async (): Promise<void> => await Promise.reject(closeFailure) } as Playwright.BrowserContext
        };

        const reported = await closeParticipantContext(participant, async () => await Promise.reject(cleanupFailure))
            .then(() => undefined, (error: Error) => error);

        expect(reported).toBeInstanceOf(AggregateError);
        expect((reported as AggregateError).errors).toEqual([cleanupFailure, closeFailure]);
        expect((reported as AggregateError).message).toBe(
            'The page cleanup failed (the cleanup failed) and then closing its context failed.'
        );
    });

    it('closes the context when the cleanup fails, and reports the failure after the close', async () => {
        const events: string[] = [];
        const failure = new Error('the cleanup failed');

        await expect(
            closeParticipantContext(createParticipant(events), async () => {
                events.push('cleanup');
                throw failure;
            })
        ).rejects.toBe(failure);

        expect(events).toEqual(['cleanup', 'close']);
    });
});
