import type { ReactNode } from 'react';
import styles from './primitives.module.css';

export type StatePanelKind = 'empty' | 'stale' | 'error';

export function StatePanel({ kind, title, children }: Readonly<{
    kind: StatePanelKind;
    title: string;
    children: ReactNode;
}>) {
    return (
        <section aria-live={kind === 'error' ? 'assertive' : 'polite'} className={styles.statePanel} data-state={kind}>
            <h2>{title}</h2>
            <div>{children}</div>
        </section>
    );
}
