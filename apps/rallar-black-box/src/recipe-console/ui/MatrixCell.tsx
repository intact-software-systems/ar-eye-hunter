import type { ButtonHTMLAttributes } from 'react';
import { StatusMark, type OperationalStatus } from './StatusMark.tsx';
import styles from './primitives.module.css';

export type MatrixCellProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & Readonly<{
    label: string;
    selected?: boolean;
    status: OperationalStatus;
}>;

export function MatrixCell({ label, selected = false, status, type = 'button', ...props }: MatrixCellProps) {
    return (
        <button
            {...props}
            aria-label={label}
            aria-selected={selected}
            className={styles.matrixCell}
            role="gridcell"
            type={type}
        >
            <StatusMark label={label} status={status} />
        </button>
    );
}
