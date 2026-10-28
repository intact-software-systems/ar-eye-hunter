import type { ALMessage } from '../al-contract.ts';
import { toALCorrId } from '../reply/to-al-reply-actions.ts';

/** The identity a message-scoped diagnostic ends with: the same trace and correlation the server rows name. */
export interface ALMessageTrace {
    readonly traceId: string;
    readonly corrId: string;
}

/** Both fields are null together, and only where the producer holds no decoded message. */
export type ALMessageTraceOrNull = ALMessageTrace | Readonly<{ traceId: null; corrId: null; }>;

export function toALMessageTrace(message: ALMessage): ALMessageTrace {
    return { traceId: message.id.traceId, corrId: toALCorrId(message) };
}

export function toALMessageTraceOrNull(message: ALMessage | undefined): ALMessageTraceOrNull {
    return message === undefined ? { traceId: null, corrId: null } : toALMessageTrace(message);
}
