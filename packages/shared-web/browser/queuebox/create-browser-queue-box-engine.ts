import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

export function createBrowserQueueBoxEngine(): InboxOutboxEngine {
    const qboxEngine = new InboxOutboxEngine();
    qboxEngine.start();

    return qboxEngine;
}
