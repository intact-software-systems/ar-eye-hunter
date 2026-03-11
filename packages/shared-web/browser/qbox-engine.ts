import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

export function initialiseQBoxEngine() {
    const qboxEngine = new InboxOutboxEngine();
    qboxEngine.start();

    return qboxEngine;
}
