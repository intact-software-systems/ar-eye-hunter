const DEFAULT_RALLAR_WAIT_FOR_OPEN_TIMEOUT_MS = 5_000;

export function normalizeWaitTimeoutMs(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
        return DEFAULT_RALLAR_WAIT_FOR_OPEN_TIMEOUT_MS;
    }
    return Math.max(0, Math.floor(timeoutMs));
}
