import type { HttpProbeDiagnostics } from '../arena-connection-contracts.ts';

interface HttpProbeValue {
    readonly apiBaseUrl?: string;
    readonly wsBaseUrl?: string;
    readonly iceServers?: readonly object[];
}

export async function readHttpProbe(
    operation: (signal: AbortSignal) => Promise<HttpProbeValue>,
    parentSignal: AbortSignal,
    nowMs: () => number
): Promise<HttpProbeDiagnostics> {
    if (parentSignal?.aborted) {
        return { status: 'idle' };
    }
    const controller = new AbortController();
    const startedAtEpochMs = nowMs();
    const timeout = window.setTimeout(() => controller.abort(), 2_500);
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    try {
        const value = await operation(controller.signal);
        if (parentSignal?.aborted) {
            return { status: 'idle' };
        }
        const finishedAtEpochMs = nowMs();
        return {
            status: 'ok',
            checkedAtEpochMs: finishedAtEpochMs,
            durationMs: finishedAtEpochMs - startedAtEpochMs,
            detail: toHttpProbeDetail(value)
        };
    }
    catch (error) {
        const finishedAtEpochMs = nowMs();
        return {
            status: 'error',
            checkedAtEpochMs: finishedAtEpochMs,
            durationMs: finishedAtEpochMs - startedAtEpochMs,
            reason: error instanceof Error ? error.message : String(error)
        };
    }
    finally {
        parentSignal?.removeEventListener('abort', abort);
        window.clearTimeout(timeout);
    }
}

function toHttpProbeDetail(value: HttpProbeValue): string | undefined {
    if (value.iceServers) {
        return `${value.iceServers.length} ICE servers`;
    }
    if (value.apiBaseUrl || value.wsBaseUrl) {
        return [value.apiBaseUrl, value.wsBaseUrl].filter(Boolean).join(' / ');
    }
    return undefined;
}
