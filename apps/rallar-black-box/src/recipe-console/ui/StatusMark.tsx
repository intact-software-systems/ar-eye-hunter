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

export function StatusMark({ status, label }: Readonly<{
    status: OperationalStatus;
    label?: string;
}>) {
    const visibleLabel = label ?? `${status[0].toUpperCase()}${status.slice(1)}`;
    return (
        <span className={styles.statusMark} data-status={status}>
            <span
                aria-hidden="true"
                className={styles.statusShape}
                data-shape={SHAPES[status]}
                data-status-shape
            />
            <span>{visibleLabel}</span>
        </span>
    );
}
