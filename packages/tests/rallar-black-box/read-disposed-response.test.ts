import { describe, expect, it } from 'vitest';

import { readDisposedResponse } from '../../../tests/playwright/rallar-black-box/read-disposed-response.ts';

describe('a disposed response read', () => {
    interface FakeResponse {
        readonly events: string[];
        dispose(): Promise<void>;
    }

    function createResponse(disposeFailure: Error | undefined = undefined): FakeResponse {
        const events: string[] = [];
        return {
            events,
            dispose: async () => {
                events.push('dispose');
                if (disposeFailure !== undefined) {
                    throw disposeFailure;
                }
            }
        };
    }

    it('returns what the reader read and disposes the response after the read', async () => {
        const response = createResponse();

        const value = await readDisposedResponse(response, async (read) => {
            read.events.push('read');
            return 'the body';
        });

        expect(value).toBe('the body');
        expect(response.events).toEqual(['read', 'dispose']);
    });

    it('disposes the response and rethrows the reader failure when the reader throws', async () => {
        const response = createResponse();
        const readFailure = new Error('the assertion on the response failed');

        await expect(readDisposedResponse(response, async () => {
            throw readFailure;
        })).rejects.toBe(readFailure);
        expect(response.events).toEqual(['dispose']);
    });

    it('keeps the reader failure when the dispose after it also fails', async () => {
        const response = createResponse(new Error('the dispose failed'));
        const readFailure = new Error('the body could not be decoded');

        await expect(readDisposedResponse(response, async () => {
            throw readFailure;
        })).rejects.toBe(readFailure);
        expect(response.events).toEqual(['dispose']);
    });

    it('reports a dispose failure after a successful read', async () => {
        const disposeFailure = new Error('the dispose failed');
        const response = createResponse(disposeFailure);

        await expect(readDisposedResponse(response, async () => 'the body')).rejects.toBe(disposeFailure);
    });
});
