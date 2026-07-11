import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';
import type { ExecutePreviewModel } from '../data/recipe-console-models.ts';
import type { RallarBlackBoxRecipeFixture } from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
import { StatusMark } from '../ui/StatusMark.tsx';
import { useExecutePreview, type ExecutePreviewStatus } from './use-execute-preview.ts';
import styles from './ExecutePreview.module.css';

export type ExecutePreviewProps = Readonly<{
    model: ExecutePreviewModel;
    onInspectorChange(content: ReactNode | undefined): void;
}>;

const STATUS_LABELS: Record<ExecutePreviewStatus, string> = {
    idle: 'Idle preview',
    'staged-preview': 'Staged preview',
    'started-preview': 'Started preview',
};

function RecipeDetails({ model, fixture, selectedTargetCount }: Readonly<{
    model: ExecutePreviewModel;
    fixture: RallarBlackBoxRecipeFixture;
    selectedTargetCount: number;
}>) {
    const recipe = fixture.recipe;
    const configuredSample = fixture.fixtureId === model.selectedFixture.fixtureId;
    return (
        <div className={styles.inspector}>
            <p className={styles.eyebrow}>Recipe details</p>
            <h2>{fixture.label}</h2>
            <p>{fixture.description}</p>
            <dl className={styles.details}>
                <dt>Provider</dt><dd>Simulated preview</dd>
                <dt>Sample group</dt><dd><code>{model.group.applicationId}/{model.group.workspaceId}/{model.group.groupId}</code></dd>
                <dt>Targets</dt><dd>{selectedTargetCount}</dd>
                <dt>Schema</dt><dd>Version {recipe.schemaVersion ?? 1}</dd>
                <dt>Summary</dt><dd>{configuredSample ? model.commandPreview.label : `${recipe.commands.length} manifest commands`}</dd>
            </dl>
            <h3>Command sequence</h3>
            <ol className={styles.commandList}>
                {recipe.commands.map(command => (
                    <li key={command.commandId ?? command.kind}>
                        <code>{command.commandId ?? command.kind}</code> · {command.kind}
                    </li>
                ))}
            </ol>
            <p>Stage/load → ACK/readiness → Start/run → Result</p>
        </div>
    );
}

export function ExecutePreview({ model, onInspectorChange }: ExecutePreviewProps) {
    const preview = useExecutePreview(model);
    const normalizedQuery = preview.query.trim().toLowerCase();
    const visibleRecipes = model.catalogRows.filter(fixture =>
        !normalizedQuery || [
            fixture.label,
            fixture.description,
            fixture.recipe.recipeId,
        ].some(value => value.toLowerCase().includes(normalizedQuery))
    );
    const selectedFixture = model.catalogRows.find(
        fixture => fixture.fixtureId === preview.selectedRecipeId,
    ) ?? model.selectedFixture;
    const inspector = useMemo(() => (
        <RecipeDetails
            fixture={selectedFixture}
            model={model}
            selectedTargetCount={preview.selectedTargetIds.length}
        />
    ), [model, preview.selectedTargetIds.length, selectedFixture]);

    useEffect(() => {
        onInspectorChange(inspector);
        return () => onInspectorChange(undefined);
    }, [inspector, onInspectorChange]);

    return (
        <div className={styles.execute}>
            <section className={styles.region} aria-labelledby="recipe-ledger-heading">
                <div className={styles.regionHeader}>
                    <div><p className={styles.eyebrow}>Shared fixture catalog</p><h2 id="recipe-ledger-heading">Recipe ledger</h2></div>
                    <span className={styles.previewBadge}>Preview only</span>
                </div>
                <label>
                    <span className={styles.eyebrow}>Search recipes</span>
                    <input
                        aria-label="Search recipes"
                        className={styles.search}
                        onChange={event => preview.setQuery(event.currentTarget.value)}
                        type="search"
                        value={preview.query}
                    />
                </label>
                <div aria-label="Recipes" className={styles.recipeLedger} role="region">
                    {visibleRecipes.map(fixture => (
                        <button
                            aria-selected={fixture.fixtureId === preview.selectedRecipeId}
                            className={styles.recipeButton}
                            key={fixture.fixtureId}
                            onClick={() => preview.selectRecipe(fixture.fixtureId)}
                            type="button"
                        >
                            <span className={styles.recipeRowHeader}><strong>{fixture.label}</strong><code>{fixture.fixtureId}</code></span>
                            <span className={styles.recipeDescription}>{fixture.description}</span>
                        </button>
                    ))}
                </div>
            </section>

            <section aria-label="Sample targets and preflight" className={styles.region}>
                <div className={styles.targetSummary}>
                    <div><p className={styles.eyebrow}>Deterministic sample data</p><h2>Targets</h2></div>
                    <strong>{preview.selectedTargetIds.length}/{model.targetRows.length} selected</strong>
                </div>
                <p><strong>Control connectivity</strong> · <span>Required · not checked in preview</span></p>
                <div className={styles.targetTable}>
                    {model.targetRows.map(target => (
                        <label className={styles.targetRow} key={target.agentId}>
                            <input
                                aria-label={`Select ${target.agentId}`}
                                checked={preview.selectedTargetIds.includes(target.agentId)}
                                onChange={() => preview.toggleTarget(target.agentId)}
                                type="checkbox"
                            />
                            <span className={styles.targetIdentity}><code>{target.agentId}</code><span className={styles.targetMeta}>{target.principalId} · {target.reason}</span></span>
                            <StatusMark label={target.status === 'matched' ? 'Matched' : target.status} status={target.targetable ? 'passed' : 'warning'} />
                        </label>
                    ))}
                </div>
                <details
                    className={styles.preflight}
                    onToggle={event => preview.setPreflightExpanded(event.currentTarget.open)}
                    open={preview.preflightExpanded}
                >
                    <summary>Expanded preflight · {model.commandPreview.label}</summary>
                    <div className={styles.preflightGrid}>
                        <div><span>Schema</span><strong>{model.preflight.errors.length ? 'Blocked' : 'Ready'}</strong></div>
                        <div><span>Target resolution</span><strong>{model.targetRows.every(row => row.targetable) ? 'Ready' : 'Review'}</strong></div>
                        <div><span>Commands</span><strong>{model.preflight.manifestCommandCount}</strong></div>
                    </div>
                    {model.preflight.warnings.map(warning => <p className={styles.notice} key={warning}>{warning}</p>)}
                </details>
            </section>

            <div className={styles.actionBand}>
                <div className={styles.actionStatus}>
                    <strong data-preview-status>{STATUS_LABELS[preview.previewStatus]}</strong>
                    <span>{preview.selectedTargetIds.length}/{model.targetRows.length} targetable</span>
                </div>
                <div className={styles.actions}>
                    <button type="button">Export Preview</button>
                    <button aria-describedby="cancel-preview-reason" disabled type="button">Cancel Preview</button>
                    <button onClick={preview.stagePreview} type="button">Stage Preview</button>
                    <button data-primary-action="true" onClick={preview.startPreview} type="button">Start Preview</button>
                </div>
                <p className={styles.cancelReason} id="cancel-preview-reason">Nothing to cancel until live execution is available.</p>
                <p className={styles.notice}>Live execution begins in Iteration 4.</p>
            </div>
        </div>
    );
}
