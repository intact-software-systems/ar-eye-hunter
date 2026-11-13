import type { Context } from 'hono';

declare module 'hono' {
    interface ContextVariableMap {
        traceId: string;
    }
}

/** The HTTP timing middleware runs outermost on `/api/*` and sets the trace before any route handler. */
export function readApiRequestTraceId(context: Context): string {
    const traceId: string | undefined = context.get('traceId');
    if (traceId === undefined) {
        throw new Error('API request trace is missing: the HTTP timing middleware did not run');
    }
    return traceId;
}
