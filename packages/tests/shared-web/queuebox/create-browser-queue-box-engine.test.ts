import { createBrowserQueueBoxEngine } from '@shared-web/browser/queuebox/create-browser-queue-box-engine.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('createBrowserQueueBoxEngine', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts scheduled queue work before returning the engine', () => {
        vi.useFakeTimers();

        const engine = createBrowserQueueBoxEngine();

        expect(vi.getTimerCount()).toBe(1);
        engine.stop();
        expect(vi.getTimerCount()).toBe(0);
    });
});
