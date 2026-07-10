import { formatRelativeDuration } from '../../shared/time-format.ts';

export function formatPercent(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) {
        return '-';
    }
    return `${Math.round(value * 100)}%`;
}

export function formatFleetDuration(value: number | undefined): string {
    if (value === undefined) {
        return '-';
    }
    return value >= 1000 ? formatRelativeDuration(value) : `${Math.round(value)}ms`;
}

export function formatStreamRate(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) {
        return '-';
    }
    return `${Math.round(value * 100) / 100}Hz`;
}
