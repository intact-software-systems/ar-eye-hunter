import type {
    DistributedRunReadinessRow,
    DistributedRunRecipeProgressRow
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import { StatusMark } from '../ui/StatusMark.tsx';
import { createMonitorRecipeEvidenceSelectionId, type MonitorEvidenceSelection } from './monitor-selection.ts';
import styles from './MonitorProgress.module.css';
import { MonitorWindowTruth } from './MonitorWindowTruth.tsx';
import { useMonitorWindow } from './use-monitor-window.ts';

const RECIPE_CONTENT_ID = 'monitor-recipe-progress-window';
const READINESS_CONTENT_ID = 'monitor-readiness-window';

export function MonitorProgressEvidence({
    contextKey,
    recipes,
    readiness,
    selected,
    onInspect
}: Readonly<{
    contextKey: string;
    recipes: readonly DistributedRunRecipeProgressRow[];
    readiness: readonly DistributedRunReadinessRow[];
    selected?: MonitorEvidenceSelection;
    onInspect(
        selection: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement
    ): void;
}>) {
    const recipeWindow = useMonitorWindow({
        contextKey,
        section: 'recipes',
        total: recipes.length
    });
    const readinessWindow = useMonitorWindow({
        contextKey,
        section: 'readiness',
        total: readiness.length
    });
    const visibleRecipes = recipes.slice(
        recipeWindow.model.startIndex,
        recipeWindow.model.endIndexExclusive
    );
    const visibleReadiness = readiness.slice(
        readinessWindow.model.startIndex,
        readinessWindow.model.endIndexExclusive
    );
    return (
        <section className={styles.progress} data-monitor-progress>
            <div className={styles.progressBlock}>
                <header>
                    <div>
                        <p className={styles.eyebrow}>Recipe rollups</p>
                        <h2>Recipe progress</h2>
                    </div>
                </header>
                {recipeWindow.model.total > recipeWindow.model.windowSize
                    ? (
                        <div data-monitor-window-controls {...recipeWindow.controlsFocusProps}>
                            <ExplicitWindowControls
                                contentId={RECIPE_CONTENT_ID}
                                itemLabel="recipes"
                                label="Recipes"
                                model={recipeWindow.model}
                                onNext={recipeWindow.next}
                                onPrevious={recipeWindow.previous}
                            />
                        </div>
                    )
                    : null}
                <MonitorWindowTruth
                    itemLabel="recipes"
                    label="Recipes"
                    window={recipeWindow}
                />
                {visibleRecipes.length === 0 ? <p>No recipe progress has arrived.</p> : (
                    <div
                        className={styles.recipeGrid}
                        id={RECIPE_CONTENT_ID}
                        {...recipeWindow.contentFocusProps}
                    >
                        {visibleRecipes.map((recipe, offset) => {
                            const recipeEvidenceId = createMonitorRecipeEvidenceSelectionId({
                                recipeId: recipe.recipeId,
                                role: recipe.role,
                                profile: recipe.profile
                            });
                            return (
                                <button
                                    aria-pressed={selected?.kind === 'recipe' && selected.id === recipeEvidenceId}
                                    className={styles.recipeRow}
                                    data-monitor-recipe-row
                                    data-monitor-source-ordinal={recipeWindow.model.startIndex + offset}
                                    key={recipeWindow.model.startIndex + offset}
                                    onClick={(event) =>
                                        onInspect(
                                            { kind: 'recipe', id: recipeEvidenceId },
                                            {
                                                agentId: undefined,
                                                recipeId: recipe.recipeId,
                                                commandId: undefined
                                            },
                                            event.currentTarget
                                        )}
                                    type="button"
                                >
                                    <span>
                                        <strong>
                                            <ExactIdentifier value={recipe.recipeId} />
                                        </strong>
                                        <small>{recipe.role ?? recipe.profile ?? 'All assigned roles'}</small>
                                    </span>
                                    <span>{recipe.passedCount}/{recipe.targetCount} passed</span>
                                    <span className={styles.counts}>
                                        <b data-tone="running">{recipe.runningCount} running</b>
                                        <b data-tone="failed">{recipe.failedCount} failed</b>
                                        <b>{recipe.missingCount} missing</b>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
            <div className={styles.progressBlock}>
                <header>
                    <div>
                        <p className={styles.eyebrow}>Dispatch acknowledgement</p>
                        <h2>ACK &amp; barrier readiness</h2>
                    </div>
                </header>
                {readinessWindow.model.total > readinessWindow.model.windowSize
                    ? (
                        <div data-monitor-window-controls {...readinessWindow.controlsFocusProps}>
                            <ExplicitWindowControls
                                contentId={READINESS_CONTENT_ID}
                                itemLabel="readiness rows"
                                label="Readiness"
                                model={readinessWindow.model}
                                onNext={readinessWindow.next}
                                onPrevious={readinessWindow.previous}
                            />
                        </div>
                    )
                    : null}
                <MonitorWindowTruth
                    itemLabel="readiness rows"
                    label="Readiness"
                    window={readinessWindow}
                />
                {visibleReadiness.length === 0 ? <p>No stage acknowledgements are expected yet.</p> : (
                    <ul
                        className={styles.readinessList}
                        id={READINESS_CONTENT_ID}
                        {...readinessWindow.contentFocusProps}
                    >
                        {visibleReadiness.map((row, offset) => {
                            const evidence = {
                                kind: row.commandId ? 'command' as const : 'agent' as const,
                                id: row.commandId ?? row.agentId
                            };
                            const active = selected?.kind === evidence.kind &&
                                selected.id === evidence.id;
                            const sourceOrdinal = readinessWindow.model.startIndex + offset;
                            return (
                                <li
                                    data-monitor-readiness-row
                                    data-monitor-source-ordinal={sourceOrdinal}
                                    key={sourceOrdinal}
                                >
                                    <button
                                        aria-pressed={active}
                                        onClick={(event) =>
                                            onInspect(
                                                evidence,
                                                {
                                                    agentId: row.agentId,
                                                    commandId: row.commandId,
                                                    recipeId: undefined
                                                },
                                                event.currentTarget
                                            )}
                                        type="button"
                                    >
                                        <ExactIdentifier value={row.agentId} />
                                        <span>{row.role ?? 'Participant'}</span>
                                    </button>
                                    <StatusMark label={statusLabel(row.status)} status={statusTone(row.status)} />
                                    <span>{readinessTiming(row)}</span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </section>
    );
}

function statusTone(status: DistributedRunReadinessRow['status']) {
    if (status === 'ready' || status === 'passed') {
        return 'passed' as const;
    }
    if (status === 'failed') {
        return 'failed' as const;
    }
    if (status === 'running') {
        return 'running' as const;
    }
    if (status === 'pending' || status === 'queued') {
        return 'partial' as const;
    }
    return 'disabled' as const;
}

function statusLabel(status: DistributedRunReadinessRow['status']): string {
    return `${status[0].toUpperCase()}${status.slice(1)}`;
}

function readinessTiming(row: DistributedRunReadinessRow): string {
    if (row.error) {
        return row.error;
    }
    if (row.latencyMs !== undefined) {
        return `${row.latencyMs} ms ACK`;
    }
    if (row.completedAtEpochMs) {
        return `ACK ${formatTime(row.completedAtEpochMs)}`;
    }
    if (row.queuedAtEpochMs) {
        return `Queued ${formatTime(row.queuedAtEpochMs)}`;
    }
    return 'Awaiting dispatch';
}

function formatTime(value: number): string {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
