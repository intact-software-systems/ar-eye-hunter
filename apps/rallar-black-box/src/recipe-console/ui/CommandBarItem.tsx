import type { ReactNode } from 'react';
import styles from './primitives.module.css';

export function CommandBarItem({ label, children }: Readonly<{
    label: string;
    children: ReactNode;
}>) {
    return (
        <span className={styles.commandBarItem}>
            <span className={styles.commandBarLabel}>{label}</span>
            <span className={styles.commandBarValue}>{children}</span>
        </span>
    );
}
