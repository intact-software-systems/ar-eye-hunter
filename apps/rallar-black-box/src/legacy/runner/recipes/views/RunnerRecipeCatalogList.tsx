import type { Dispatch, SetStateAction } from 'react';
import { distributedRecipeCommandPreview } from '../../../../distributed-recipes.ts';
import type { RunnerRecipeCatalogEntry } from '../runner-recipe-catalog.ts';

type RunnerRecipeCatalogListProps = Readonly<{
    filteredRecipes: readonly RunnerRecipeCatalogEntry[];
    selectedRecipe?: RunnerRecipeCatalogEntry;
    localDisabledReason?: string;
    localRunning: boolean;
    distributedDisabledReason?: string;
    setSelectedRecipeId: Dispatch<SetStateAction<string>>;
    runLocalRecipe(): Promise<void>;
    runDistributedRecipe(): Promise<void>;
    setShowEditor: Dispatch<SetStateAction<boolean>>;
    copyText(text: string, message: string): Promise<void>;
}>;

export function RunnerRecipeCatalogList({
    filteredRecipes,
    selectedRecipe,
    localDisabledReason,
    localRunning,
    distributedDisabledReason,
    setSelectedRecipeId,
    runLocalRecipe,
    runDistributedRecipe,
    setShowEditor,
    copyText
}: RunnerRecipeCatalogListProps) {
    return (
        <section className="runner-recipe-list" aria-label="Recipe catalog">
            {filteredRecipes.map((entry) => {
                const selected = selectedRecipe?.id === entry.id;
                const preview = entry.recipe
                    ? distributedRecipeCommandPreview(entry.recipe)
                    : undefined;
                return (
                    <article
                        className={`runner-recipe-card ${selected ? 'selected' : ''}`}
                        key={entry.id}
                    >
                        <button
                            type="button"
                            className="runner-recipe-select"
                            onClick={() => setSelectedRecipeId(entry.id)}
                        >
                            <span>
                                <strong>{entry.title}</strong>
                                <small>{entry.path}</small>
                            </span>
                            <span
                                className={`pill ${entry.source === 'app-local' ? 'active' : 'muted'}`}
                            >
                                {entry.source}
                            </span>
                        </button>
                        <p>{entry.description}</p>
                        <div className="badge-list">
                            <span className="pill muted">
                                {entry.providerMode}
                            </span>
                            <span
                                className={`pill ${entry.live ? 'warn' : 'good'}`}
                            >
                                {entry.live ? 'live' : 'local-safe'}
                            </span>
                            <span className="pill active">
                                {preview?.label ??
                                    `${entry.commandCount ?? 0} command${entry.commandCount === 1 ? '' : 's'}`}
                            </span>
                        </div>
                        {selected && (
                            <div className="runner-recipe-card-actions">
                                <button
                                    type="button"
                                    disabled={Boolean(localDisabledReason) || localRunning}
                                    title={localDisabledReason}
                                    onClick={() => void runLocalRecipe()}
                                >
                                    Run in this browser
                                </button>
                                <button
                                    type="button"
                                    disabled={Boolean(distributedDisabledReason) ||
                                        localRunning}
                                    title={distributedDisabledReason}
                                    onClick={() => void runDistributedRecipe()}
                                >
                                    Run on connected agents
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowEditor((value) => !value)}
                                >
                                    Open in editor
                                </button>
                                <button
                                    type="button"
                                    onClick={() =>
                                        void copyText(
                                            entry.copyCommand,
                                            'Copied recipe command.'
                                        )}
                                >
                                    Copy command
                                </button>
                            </div>
                        )}
                    </article>
                );
            })}
            {filteredRecipes.length === 0 && <div className="empty-state">No recipes match the filters</div>}
        </section>
    );
}
