import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './primitives.module.css';

export type SelectableRowProps =
    & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>
    & Readonly<{
        selected: boolean;
        children: ReactNode;
    }>;

export function SelectableRow({ selected, children, type = 'button', ...props }: SelectableRowProps) {
    return (
        <button
            {...props}
            aria-selected={selected}
            className={styles.selectableRow}
            role="option"
            type={type}
        >
            <span aria-hidden="true" className={styles.selectionRail} />
            <span className={styles.rowContent}>{children}</span>
        </button>
    );
}
