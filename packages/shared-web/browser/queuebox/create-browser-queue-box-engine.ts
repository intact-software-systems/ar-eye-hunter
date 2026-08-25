import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

export function createBrowserQueueBoxEngine(): InboxOutboxEngine {
    const qboxEngine = new InboxOutboxEngine();
    qboxEngine.start();

    return qboxEngine;
}
