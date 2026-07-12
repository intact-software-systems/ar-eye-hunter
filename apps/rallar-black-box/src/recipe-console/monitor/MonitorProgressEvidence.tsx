import type {
    DistributedRunReadinessRow,
    DistributedRunRecipeProgressRow,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { StatusMark } from '../ui/StatusMark.tsx';
import {
    createMonitorRecipeEvidenceSelectionId,
    type MonitorEvidenceSelection,
} from './monitor-selection.ts';
import styles from './MonitorProgress.module.css';

const PROGRESS_LIMIT = 60;

export function MonitorProgressEvidence({
    recipes,
    readiness,
    selected,
    onInspect,
}: Readonly<{
    recipes: readonly DistributedRunRecipeProgressRow[];
    readiness: readonly DistributedRunReadinessRow[];
    selected?: MonitorEvidenceSelection;
    onInspect(
        selection: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement,
    ): void;
}>) {
    const visibleRecipes = recipes.slice(0, PROGRESS_LIMIT);
    const visibleReadiness = readiness.slice(0, PROGRESS_LIMIT);
    return (
        <section className={styles.progress} data-monitor-progress>
            <div className={styles.progressBlock}>
                <header>
                    <div><p className={styles.eyebrow}>Recipe rollups</p><h2>Recipe progress</h2></div>
                    {recipes.length > PROGRESS_LIMIT ? <span>{recipes.length - PROGRESS_LIMIT} omitted</span> : null}
                </header>
                {visibleRecipes.length === 0 ? <p>No recipe progress has arrived.</p> : (
                    <div className={styles.recipeGrid}>
                        {visibleRecipes.map(recipe => {
                            const recipeEvidenceId = createMonitorRecipeEvidenceSelectionId({
                                recipeId: recipe.recipeId,
                                role: recipe.role,
                                profile: recipe.profile,
                            });
                            return (
                                <button
                                aria-pressed={selected?.kind === 'recipe' && selected.id === recipeEvidenceId}
                                className={styles.recipeRow}
                                key={recipeEvidenceId}
                                onClick={event => onInspect(
                                    { kind: 'recipe', id: recipeEvidenceId },
                                    {
                                        agentId: undefined,
                                        recipeId: recipe.recipeId,
                                        commandId: undefined,
                                    },
                                    event.currentTarget,
                                )}
                                type="button"
                            >
                                <span><strong>{recipe.recipeId}</strong><small>{recipe.role ?? recipe.profile ?? 'All assigned roles'}</small></span>
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
                    <div><p className={styles.eyebrow}>Dispatch acknowledgement</p><h2>ACK &amp; barrier readiness</h2></div>
                    {readiness.length > PROGRESS_LIMIT ? <span>{readiness.length - PROGRESS_LIMIT} omitted</span> : null}
                </header>
                {visibleReadiness.length === 0 ? <p>No stage acknowledgements are expected yet.</p> : (
                    <ul className={styles.readinessList}>
                        {visibleReadiness.map((row, index) => (
                            <li key={`${row.agentId}:${row.commandId ?? index}`}>
                                <button
                                    onClick={event => onInspect(
                                        { kind: row.commandId ? 'command' : 'agent', id: row.commandId ?? row.agentId },
                                        {
                                            agentId: row.agentId,
                                            commandId: row.commandId,
                                            recipeId: undefined,
                                        },
                                        event.currentTarget,
                                    )}
                                    type="button"
                                ><code>{row.agentId}</code><span>{row.role ?? 'Participant'}</span></button>
                                <StatusMark label={statusLabel(row.status)} status={statusTone(row.status)} />
                                <span>{readinessTiming(row)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}

function statusTone(status: DistributedRunReadinessRow['status']) {
    if (status === 'ready' || status === 'passed') return 'passed' as const;
    if (status === 'failed') return 'failed' as const;
    if (status === 'running') return 'running' as const;
    if (status === 'pending' || status === 'queued') return 'partial' as const;
    return 'disabled' as const;
}

function statusLabel(status: DistributedRunReadinessRow['status']): string {
    return `${status[0].toUpperCase()}${status.slice(1)}`;
}

function readinessTiming(row: DistributedRunReadinessRow): string {
    if (row.error) return row.error;
    if (row.latencyMs !== undefined) return `${row.latencyMs} ms ACK`;
    if (row.completedAtEpochMs) return `ACK ${formatTime(row.completedAtEpochMs)}`;
    if (row.queuedAtEpochMs) return `Queued ${formatTime(row.queuedAtEpochMs)}`;
    return 'Awaiting dispatch';
}

function formatTime(value: number): string {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
