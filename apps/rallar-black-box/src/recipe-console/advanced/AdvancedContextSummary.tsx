import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import type { AdvancedWorkspaceModel } from './advanced-workspace-contract.ts';
import styles from './AdvancedWorkspace.module.css';

export function AdvancedContextSummary({
    model
}: Readonly<{ model: AdvancedWorkspaceModel; }>) {
    return (
        <section
            aria-labelledby="advanced-context-heading"
            className={styles.context}
            data-advanced-context
        >
            <header className={styles.sectionHeader}>
                <div>
                    <h2 id="advanced-context-heading">Current diagnostic context</h2>
                    <p>
                        {model.contextSourceLabel}. Links carry only bounded, allow-listed context into the selected
                        legacy tool.
                    </p>
                </div>
            </header>
            <dl className={styles.contextGrid}>
                {model.contextRows.map((row) => (
                    <div
                        className={styles.contextRow}
                        data-context-field={row.field}
                        data-context-status={row.status}
                        key={row.field}
                    >
                        <dt>{row.label}</dt>
                        <dd>
                            {row.value ? <ExactIdentifier value={row.value} /> : null}
                            {row.message
                                ? (
                                    <span className={styles.contextMessage}>
                                        {row.message}
                                    </span>
                                )
                                : null}
                        </dd>
                    </div>
                ))}
            </dl>
            {model.notices.length > 0
                ? (
                    <div className={styles.notices}>
                        <h3>Context notices</h3>
                        <ul>
                            {model.notices.map((notice) => <li key={notice}>{notice}</li>)}
                        </ul>
                    </div>
                )
                : null}
        </section>
    );
}
