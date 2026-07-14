import type { RtcConnectStageStatus } from '../../../rtc-diagnostics.ts';

export function stageTone(status: RtcConnectStageStatus): string {
    if (status === 'observed') return 'good';
    if (status === 'failed') return 'bad';
    if (status === 'warning') return 'warn';
    return 'muted';
}

export function formatList(values: readonly string[]): string {
    return values.length > 0 ? values.join(', ') : '-';
}
