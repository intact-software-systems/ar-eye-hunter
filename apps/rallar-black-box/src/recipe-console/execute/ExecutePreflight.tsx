import type {
    DistributedRecipeCatalogEntryProjection,
} from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import { StatusMark } from '../ui/StatusMark.tsx';
import { ExecutePreflightIssueList } from './ExecutePreflightIssueList.tsx';
import { ExecutePreflightTree } from './ExecutePreflightTree.tsx';
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
    const contextKey = JSON.stringify([
        'execute-preflight-v2',
        entry.item.recipe.recipeId,
    ]);
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
            <details className={styles.details}>
                <summary>{preflightDetailsLabel({
                    errorCount: schema.errors.length + preflight.errors.length,
                    warningCount: schema.warnings.length + preflight.warnings.length,
                })}</summary>
                <div className={styles.detailsBody}>
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
                    <ExecutePreflightIssueList contextKey={contextKey} id="schema-errors" label="Schema errors" tone="error" values={schema.errors} />
                    <ExecutePreflightIssueList contextKey={contextKey} id="schema-warnings" label="Schema warnings" tone="warning" values={schema.warnings} />
                    <ExecutePreflightIssueList contextKey={contextKey} id="errors" label="Preflight errors" tone="error" values={preflight.errors} />
                    <ExecutePreflightIssueList contextKey={contextKey} id="warnings" label="Preflight warnings" tone="warning" values={preflight.warnings} />
                    <ExecutePreflightTree contextKey={contextKey} rows={preflight.tree} />
                </div>
            </details>
        </section>
    );
}

function preflightDetailsLabel(input: Readonly<{
    errorCount: number;
    warningCount: number;
}>): string {
    return `Preflight details · ${input.errorCount} ${input.errorCount === 1 ? 'error' : 'errors'} · ${input.warningCount} ${input.warningCount === 1 ? 'warning' : 'warnings'}`;
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
