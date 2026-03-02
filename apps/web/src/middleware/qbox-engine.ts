import {InboxOutboxEngine} from "@shared/services/InboxOutboxEngine.ts";

export function initialise() {
    const qboxEngine = new InboxOutboxEngine();
    qboxEngine.start();

    return qboxEngine;
}
