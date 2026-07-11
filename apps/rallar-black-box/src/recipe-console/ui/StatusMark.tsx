import styles from './primitives.module.css';

export type OperationalStatus =
    | 'running' | 'passed' | 'failed' | 'warning' | 'stale' | 'partial' | 'disabled';

const SHAPES: Record<OperationalStatus, string> = {
    running: 'notched-ring',
    passed: 'check-circle',
    failed: 'x-octagon',
    warning: 'warning-triangle',
    stale: 'clock',
    partial: 'half-circle',
    disabled: 'barred-square',
};

function StatusGlyph({ status }: Readonly<{ status: OperationalStatus }>) {
    const common = {
        'aria-hidden': true,
        className: styles.statusShape,
        'data-shape': SHAPES[status],
        'data-status-shape': true,
    } as const;
    switch (status) {
        case 'running':
            return <svg {...common} viewBox="0 0 16 16"><circle cx="8" cy="8" data-status-part="notch" r="5.5" strokeDasharray="25 10" /></svg>;
        case 'passed':
            return <svg {...common} viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M4.5 8.2l2.2 2.2 4.8-5" data-status-part="check" /></svg>;
        case 'failed':
            return <svg {...common} viewBox="0 0 16 16"><path d="M5 1.5h6L14.5 5v6L11 14.5H5L1.5 11V5z" /><g data-status-part="x"><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" /></g></svg>;
        case 'warning':
            return <svg {...common} viewBox="0 0 16 16"><path d="M8 1.5L15 14H1z" /><g data-status-part="mark"><path d="M8 5v4.5" /><circle cx="8" cy="12" fill="currentColor" r=".7" stroke="none" /></g></svg>;
        case 'stale':
            return <svg {...common} viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.7" data-status-part="hands" /></svg>;
        case 'partial':
            return <svg {...common} viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M8 2a6 6 0 010 12z" data-status-part="fill" fill="currentColor" /></svg>;
        case 'disabled':
            return <svg {...common} viewBox="0 0 16 16"><rect height="11" rx="1" width="11" x="2.5" y="2.5" /><path d="M4 12L12 4" data-status-part="bar" /></svg>;
    }
}

export function StatusMark({ status, label }: Readonly<{
    status: OperationalStatus;
    label?: string;
}>) {
    const visibleLabel = label ?? `${status[0].toUpperCase()}${status.slice(1)}`;
    return (
        <span className={styles.statusMark} data-status={status}>
            <StatusGlyph status={status} />
            <span>{visibleLabel}</span>
        </span>
    );
}
