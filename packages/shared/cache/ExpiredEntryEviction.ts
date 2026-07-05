export type ExpiredEntryEvictionOptions = Readonly<{
    deleteExpiredIntervalMs?: number;
}>;

export type ExpiredEntryEvictionHandle = Readonly<{
    dispose(): void;
}>;

export function startExpiredEntryEviction(
    options: ExpiredEntryEvictionOptions,
    deleteExpired: () => number,
): ExpiredEntryEvictionHandle | undefined {
    const intervalMs = options.deleteExpiredIntervalMs;
    if (intervalMs === undefined) {
        return undefined;
    }

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error('deleteExpiredIntervalMs must be a finite positive number');
    }

    const timer = setInterval(() => {
        deleteExpired();
    }, intervalMs);
    (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();

    return {
        dispose: () => {
            clearInterval(timer);
        },
    };
}
