import type {
    DistributedRecipeCatalogEntryProjection,
} from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import type { CSSProperties } from 'react';
import { StatusMark } from '../ui/StatusMark.tsx';
import styles from './ExecutePreflight.module.css';

export type ExecutePreflightProps = Readonly<{
    entry?: DistributedRecipeCatalogEntryProjection;
}>;

export function ExecutePreflight({ entry }: ExecutePreflightProps) {
    if (!entry) {
        return (
            <section
                aria-labelledby="execute-preflight-heading"
                className={styles.preflight}
                data-execute-preflight
            >
                <header className={styles.header}>
                    <h2 id="execute-preflight-heading">Preflight</h2>
                </header>
                <p className={styles.empty}>Select an available repository recipe to inspect preflight facts.</p>
            </section>
        );
    }

    const { preflight, schema } = entry;
    const ready = schema.ok && preflight.errors.length === 0;
    return (
        <section
            aria-labelledby="execute-preflight-heading"
            className={styles.preflight}
            data-execute-preflight
        >
            <header className={styles.header}>
                <div>
                    <p className={styles.eyebrow}>Deterministic recipe analysis</p>
                    <h2 id="execute-preflight-heading">Preflight</h2>
                </div>
                <StatusMark
                    label={ready ? 'Recipe ready' : 'Recipe blocked'}
                    status={ready ? 'passed' : 'failed'}
                />
            </header>
            <dl className={styles.metrics}>
                <Fact label="Schema" value={schema.label} />
                <Fact label="Manifest commands" value={String(preflight.manifestCommandCount)} />
                <Fact label="Effective commands" value={String(preflight.effectiveCommandCount)} />
                <Fact label="Maximum depth" value={String(preflight.maxDepth)} />
            </dl>
            <div className={styles.serviceFacts}>
                <FactList label="Provider modes" values={preflight.providerModes} />
                <FactList label="Runtime surfaces" values={preflight.runtimeSurfaces} />
                <FactList
                    emptyLabel="No live service dependency"
                    label="Live service requirements"
                    values={preflight.liveServiceRequirements}
                />
            </div>
            {preflight.serviceBadges.length > 0 ? (
                <div aria-label="Service requirements" className={styles.badges}>
                    {preflight.serviceBadges.map((badge, index) => (
                        <span
                            className={styles.badge}
                            data-tone={badge.tone}
                            key={`${badge.label}-${index}`}
                        >{badge.label}</span>
                    ))}
                </div>
            ) : null}
            <IssueList label="Schema errors" tone="error" values={schema.errors} />
            <IssueList label="Schema warnings" tone="warning" values={schema.warnings} />
            <IssueList label="Preflight errors" tone="error" values={preflight.errors} />
            <IssueList label="Preflight warnings" tone="warning" values={preflight.warnings} />
            <div className={styles.tree}>
                <h3>Command tree</h3>
                {preflight.tree.length > 0 ? (
                    <ol>
                        {preflight.tree.map((row, index) => (
                            <li
                                className={styles.treeRow}
                                data-command-kind={row.kind}
                                key={`${row.path}-${row.commandId ?? row.kind}-${index}`}
                                style={{ '--tree-depth': row.depth } as CSSProperties}
                            >
                                <span className={styles.branch} aria-hidden="true" />
                                <span className={styles.treeBody}>
                                    <span className={styles.treeHeading}>
                                        <strong>{row.label}</strong>
                                        <code>{row.commandId ?? row.kind}</code>
                                    </span>
                                    <span>{row.summary}</span>
                                    {row.details.map((detail, detailIndex) => (
                                        <small key={`${detail}-${detailIndex}`}>{detail}</small>
                                    ))}
                                    {row.warnings.map((warning, warningIndex) => (
                                        <small className={styles.inlineWarning} key={`${warning}-${warningIndex}`}>
                                            {warning}
                                        </small>
                                    ))}
                                </span>
                            </li>
                        ))}
                    </ol>
                ) : <p className={styles.empty}>No command rows are available.</p>}
            </div>
        </section>
    );
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
    return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function FactList({ label, values, emptyLabel = 'None' }: Readonly<{
    label: string;
    values: readonly string[];
    emptyLabel?: string;
}>) {
    return (
        <div>
            <h3>{label}</h3>
            <p>{values.length > 0 ? values.join(' · ') : emptyLabel}</p>
        </div>
    );
}

function IssueList({ label, tone, values }: Readonly<{
    label: string;
    tone: 'error' | 'warning';
    values: readonly string[];
}>) {
    if (values.length === 0) return null;
    return (
        <div className={styles.issues} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
            <h3>{label}</h3>
            <ul>{values.map((value, index) => <li key={`${value}-${index}`}>{value}</li>)}</ul>
        </div>
    );
}
