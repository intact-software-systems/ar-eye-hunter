export function formatTime(epochMs: number | undefined): string {
    if (!epochMs) {
        return 'never';
    }

    return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(new Date(epochMs));
}

export function formatDuration(ms: number | undefined): string {
    if (ms === undefined) {
        return '-';
    }

    return `${Math.round(ms)} ms`;
}

export function formatRelativeDuration(ms: number | undefined): string {
    if (ms === undefined || !Number.isFinite(ms)) {
        return '-';
    }

    const sign = ms < 0 ? '-' : '';
    const absoluteMs = Math.abs(ms);
    const totalSeconds = Math.round(absoluteMs / 1000);
    const totalMinutes = Math.round(totalSeconds / 60);
    const totalHours = Math.round(totalMinutes / 60);
    if (totalSeconds < 90) {
        return `${sign}${totalSeconds}s`;
    }
    if (totalMinutes < 90) {
        return `${sign}${totalMinutes}m`;
    }

    return `${sign}${totalHours}h`;
}

export function formatSignedDuration(ms: number | undefined): string {
    if (ms === undefined) {
        return '-';
    }
    return `${ms >= 0 ? '+' : ''}${formatDuration(ms)}`;
}

export function formatSignedNumber(value: number): string {
    return `${value >= 0 ? '+' : ''}${value}`;
}
