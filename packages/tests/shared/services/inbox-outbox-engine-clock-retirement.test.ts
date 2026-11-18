import { expect, it, onTestFinished, vi } from 'vitest';

import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

it.each(['schedule', 'pass', 'task'] as const)('starts no timer or work when clock retirement stops the engine during %s', async (phase) => {
    vi.useFakeTimers();
    onTestFinished(() => {
        vi.useRealTimers();
    });
    let armed = false;
    let reads = 0;
    let attempted = false;
    let stopping: Promise<void> | undefined;
    const engine = new InboxOutboxEngine({
        nowEpochMs: () => {
            if (armed && ++reads === (phase === 'task' ? 2 : 1)) {
                stopping = engine.stop();
            }
            return 1_000;
        },
        random: () => 0.5,
        reportTaskFailure: () => undefined
    });
    onTestFinished(() => engine.stop());
    engine.includeTask('retired', {
        name: 'retired',
        maxConcurrency: () => 1,
        isWork: async () => !attempted,
        runnable: async () => {
            attempted = true;
        },
        ongoingTasks: []
    });
    engine.start();
    armed = true;
    if (phase === 'schedule') {
        engine.wake();
    }
    else {
        await engine.executeOnce();
    }
    await stopping;
    expect(attempted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
});
