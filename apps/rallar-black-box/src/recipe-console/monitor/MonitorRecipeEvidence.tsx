import type { DistributedRunRecipeProgressRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import {
    createMonitorRecipeEvidenceSelectionId,
    parseMonitorRecipeEvidenceSelectionId,
    type MonitorEvidenceSelection,
    type MonitorRecipeEvidenceIdentity
} from './monitor-selection.ts';
import type { MonitorWorkspaceModel } from './monitor-workspace-model.ts';
import styles from './MonitorInspector.module.css';
import { MonitorInspectorWindow } from './MonitorInspectorWindow.tsx';

export function MonitorRecipeEvidence({
    model,
    selectionId,
    onSelectEvidence
}: Readonly<{
    model: MonitorWorkspaceModel;
    selectionId: string;
    onSelectEvidence(
        selection: MonitorEvidenceSelection,
        patch?: Partial<RecipeConsoleUrlState>
    ): void;
}>) {
    const identity = parseMonitorRecipeEvidenceSelectionId(selectionId);
    const recipeId = identity?.recipeId ?? selectionId;
    const rows = model.monitor.recipeProgress.filter((row) => row.recipeId === recipeId);
    if (rows.length === 0) {
        return (
            <p className={styles.empty}>
                The selected recipe <code>{recipeId}</code> is not in this snapshot.
            </p>
        );
    }
    if (!identity && rows.length > 1) {
        return (
            <RoleRecipeChoices
                model={model}
                onSelectEvidence={onSelectEvidence}
                recipeId={recipeId}
                rows={rows}
            />
        );
    }
    const recipe = identity
        ? rows.find((row) => sameRecipeEvidence(row, identity))
        : rows[0];
    if (!recipe) {
        return (
            <p className={styles.empty}>
                The selected role-scoped evidence for <code>{recipeId}</code> is unavailable.
            </p>
        );
    }
    return (
        <section className={styles.section}>
            <h3>Recipe rollup</h3>
            <p>Role-aware progress across the assigned targets.</p>
            <dl className={styles.facts}>
                <Fact label="Profile" value={recipe.profile ?? 'Default'} />
                <Fact label="Role" value={recipe.role ?? 'All assigned roles'} />
                <Fact label="Required" value={recipe.required ? 'Yes' : 'No'} />
                <Fact label="Targets" value={String(recipe.targetCount)} />
                <Fact label="Queued" value={String(recipe.queuedCount)} />
                <Fact label="Running" value={String(recipe.runningCount)} />
                <Fact label="Passed" value={String(recipe.passedCount)} />
                <Fact label="Failed" value={String(recipe.failedCount)} />
                <Fact label="Missing" value={String(recipe.missingCount)} />
                <Fact
                    label="Average latency"
                    value={recipe.averageLatencyMs === undefined
                        ? 'Not recorded'
                        : `${recipe.averageLatencyMs.toLocaleString('en-US')} ms`}
                />
            </dl>
        </section>
    );
}

function RoleRecipeChoices({ model, onSelectEvidence, recipeId, rows }: Readonly<{
    model: MonitorWorkspaceModel;
    onSelectEvidence(
        selection: MonitorEvidenceSelection,
        patch?: Partial<RecipeConsoleUrlState>
    ): void;
    recipeId: string;
    rows: readonly DistributedRunRecipeProgressRow[];
}>) {
    return (
        <section className={styles.section}>
            <h3>Choose role-scoped recipe evidence</h3>
            <p>This recipe has separate progress truth for multiple assignments.</p>
            <MonitorInspectorWindow
                contentClassName={styles.destinations}
                contentId="monitor-inspector-role-recipe-choices"
                contextKey={model.source.contextKey}
                itemKey={(row, index) => `${recipeEvidenceId(row)}:${index}`}
                itemLabel="role choices"
                items={rows}
                label="Role recipe choices"
                renderItem={(row) => {
                    const rowId = recipeEvidenceId(row);
                    return (
                        <button
                            onClick={() =>
                                onSelectEvidence(
                                    { kind: 'recipe', id: rowId },
                                    {
                                        agentId: undefined,
                                        recipeId: row.recipeId,
                                        commandId: undefined
                                    }
                                )}
                            type="button"
                        >
                            <span>
                                <ExactIdentifier value={row.profile ?? 'Default profile'} />
                            </span>
                            <strong>
                                <ExactIdentifier value={row.role ?? 'All assigned roles'} />
                            </strong>
                        </button>
                    );
                }}
                scope={{ kind: 'recipe', id: recipeId }}
                section="recipes"
            />
        </section>
    );
}

function recipeEvidenceId(row: DistributedRunRecipeProgressRow): string {
    return createMonitorRecipeEvidenceSelectionId({
        recipeId: row.recipeId,
        role: row.role,
        profile: row.profile
    });
}

function sameRecipeEvidence(
    row: DistributedRunRecipeProgressRow,
    identity: MonitorRecipeEvidenceIdentity
): boolean {
    return row.recipeId === identity.recipeId &&
        row.role === identity.role &&
        row.profile === identity.profile;
}

function Fact({ label, value }: Readonly<{ label: string; value: string; }>) {
    return (
        <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}
