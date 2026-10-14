import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { ALWorkHandler, type ALWorkHandlerDependencies } from '@shared/alm/work/al-work-handler.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import { fakePort, toTestALWorkReadySelection } from './al-work-test-entries.ts';

afterEach(() => {
    vi.useRealTimers();
});

interface EngineLifecycleHandlerInput {
    readonly engine: InboxOutboxEngine;
    readonly ownsQueueEngine: boolean;
    readonly selectReady: ALWorkHandlerDependencies['selectReady'];
}

function createEngineLifecycleHandler(input: EngineLifecycleHandlerInput): ALWorkHandler {
    return new ALWorkHandler({
        workerId: 'engine-lifecycle-work',
        port: fakePort({ claims: [], onRelease: () => {} }),
        queueEngine: input.engine,
        ownsQueueEngine: input.ownsQueueEngine,
        clock: { nowMs: Date.now },
        pageSize: 16,
        readinessMemoryMs: 0,
        readNextReadyAtMs: async () => undefined,
        selectReady: input.selectReady,
        claimSuccessor: undefined,
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: undefined
    });
}

it('a borrowed engine continues scheduling its other owner after handler disposal', async () => {
    vi.useFakeTimers();
    const engine = new InboxOutboxEngine();
    const completed: string[] = [];
    let otherWorkDue = false;
    engine.includeTask('other-owner', {
        name: 'other-owner',
        maxConcurrency: () => 1,
        isWork: async () => otherWorkDue,
        runnable: async () => {
            otherWorkDue = false;
            completed.push('other-owner');
        },
        ongoingTasks: []
    });
    const handler = createEngineLifecycleHandler({
        engine,
        ownsQueueEngine: false,
        selectReady: async () => toTestALWorkReadySelection([])
    });
    try {
        await handler.ready();
        engine.start();
        await vi.advanceTimersByTimeAsync(0);
        await handler.dispose();
        otherWorkDue = true;
        engine.wake();
        await vi.advanceTimersByTimeAsync(0);

        expect(completed).toEqual(['other-owner']);
    }
    finally {
        await Promise.all([handler.dispose(), engine.stop()]);
    }
});

it('an owned engine stays stopped when disposal lands during gated bootstrap', async () => {
    vi.useFakeTimers();
    const engine = new InboxOutboxEngine();
    const selectionEntered = Promise.withResolvers<void>();
    const selectionAllowed = Promise.withResolvers<void>();
    const completed: string[] = [];
    engine.includeTask('other-owner', {
        name: 'other-owner',
        maxConcurrency: () => 1,
        isWork: async () => true,
        runnable: async () => {
            completed.push('unexpected-restart');
        },
        ongoingTasks: []
    });
    const handler = createEngineLifecycleHandler({
        engine,
        ownsQueueEngine: true,
        selectReady: async () => {
            selectionEntered.resolve();
            await selectionAllowed.promise;
            return toTestALWorkReadySelection([]);
        }
    });
    const bootstrap = handler.ready();
    await selectionEntered.promise;
    const disposal = handler.dispose();
    try {
        selectionAllowed.resolve();
        await Promise.all([bootstrap, disposal]);
        await vi.advanceTimersByTimeAsync(0);

        expect(completed).toEqual([]);
    }
    finally {
        selectionAllowed.resolve();
        await Promise.all([bootstrap, disposal, handler.dispose(), engine.stop()]);
    }
});
