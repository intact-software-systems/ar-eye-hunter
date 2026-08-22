import type { DistributedRecipePreflightTreeRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { CSSProperties } from 'react';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { createExecuteWindowRevision } from './execute-window-revision.ts';
import styles from './ExecutePreflight.module.css';
import { ExecuteWindowedList } from './ExecuteWindowedList.tsx';

export function ExecutePreflightTree({
    contextKey,
    rows
}: Readonly<{
    contextKey: string;
    rows: readonly DistributedRecipePreflightTreeRow[];
}>) {
    return (
        <div className={styles.tree}>
            <h3>Command tree</h3>
            {rows.length > 0
                ? (
                    <ExecuteWindowedList
                        contentId="execute-preflight-command-window"
                        contextKey={contextKey}
                        itemKey={(_row, index) => String(index)}
                        itemLabel="command rows"
                        items={rows}
                        label="Preflight command rows"
                        ordered
                        renderItem={(row) => (
                            <li
                                className={styles.treeRow}
                                data-command-kind={row.kind}
                                data-execute-preflight-row
                                style={{ '--tree-depth': row.depth } as CSSProperties}
                            >
                                <span className={styles.branch} aria-hidden="true" />
                                <span className={styles.treeBody}>
                                    <span className={styles.treeHeading}>
                                        <strong>{row.label}</strong>
                                        <ExactIdentifier value={row.commandId ?? row.kind} />
                                    </span>
                                    <span>{row.summary}</span>
                                    {row.details.map((detail, index) => (
                                        <small key={`${detail}:${index}`}>{detail}</small>
                                    ))}
                                    {row.warnings.map((warning, index) => (
                                        <small className={styles.inlineWarning} key={`${warning}:${index}`}>
                                            {warning}
                                        </small>
                                    ))}
                                </span>
                            </li>
                        )}
                        revisionKey={createExecuteWindowRevision(rows, (row) => [
                            row.path,
                            row.depth,
                            row.kind,
                            row.commandId ?? null,
                            row.label,
                            row.summary,
                            row.details,
                            row.warnings
                        ])}
                        section="preflightRows"
                    />
                )
                : <p className={styles.empty}>No command rows are available.</p>}
        </div>
    );
}
