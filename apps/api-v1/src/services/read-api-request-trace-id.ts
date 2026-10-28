import type { Context } from 'jsr:@hono/hono@4.11.9';

declare module 'jsr:@hono/hono@4.11.9' {
    interface ContextVariableMap {
        traceId: string;
    }
}

/** The HTTP timing middleware runs outermost on `/api/*` and sets the trace before any route handler. */
export function readApiRequestTraceId(context: Context): string {
    const traceId: string | undefined = context.get('traceId');
    if (traceId === undefined) {
        throw new TypeError('API request trace is missing: the HTTP timing middleware did not run');
    }
    return traceId;
}
