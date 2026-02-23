import {InboxOutboxEngine} from "@shared/services/InboxOutboxEngine.ts";

export const qboxEngine = new InboxOutboxEngine();

qboxEngine.start();