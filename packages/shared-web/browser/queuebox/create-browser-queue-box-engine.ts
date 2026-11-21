import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

export function createBrowserQueueBoxEngine(nowEpochMs: () => number): InboxOutboxEngine {
    const qboxEngine = new InboxOutboxEngine({
        nowEpochMs,
        random: Math.random,
        reportTaskFailure: (taskId, error) => {
            console.error('Browser queue engine owned task failed', taskId, error);
        }
    });
    qboxEngine.start();

    return qboxEngine;
}
