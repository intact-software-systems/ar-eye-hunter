import type {
    DistributedRecipeCatalogEntryProjection
} from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import type { KeyboardEvent } from 'react';
import type { ExecuteRecipeSelection } from './execute-workflow-state.ts';
import styles from './ExecuteCatalog.module.css';

export type ExecuteCatalogProps = Readonly<{
    entries: readonly DistributedRecipeCatalogEntryProjection[];
    profiles: readonly string[];
    query: string;
    profile: string;
    selection: ExecuteRecipeSelection;
    disabled?: boolean;
    onQueryChange(query: string): void;
    onProfileChange(profile: string): void;
    onSelectRecipe(recipeId: string): void;
}>;

export function ExecuteCatalog({
    entries,
    profiles,
    query,
    profile,
    selection,
    disabled = false,
    onQueryChange,
    onProfileChange,
    onSelectRecipe
}: ExecuteCatalogProps) {
    const selectedRecipeId = selection.selected?.item.recipe.recipeId;
    const selectedVisible = entries.some(
        (entry) => entry.item.recipe.recipeId === selectedRecipeId
    );

    function moveSelection(
        event: KeyboardEvent<HTMLButtonElement>,
        direction: 'next' | 'previous' | 'first' | 'last'
    ): void {
        const options = Array.from(
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                '[role="option"]'
            ) ?? []
        );
        const current = options.indexOf(event.currentTarget);
        const next = direction === 'first'
            ? 0
            : direction === 'last'
            ? options.length - 1
            : direction === 'next'
            ? Math.min(current + 1, options.length - 1)
            : Math.max(current - 1, 0);
        const option = options[next];
        if (!option) {
            return;
        }
        event.preventDefault();
        option.focus();
        onSelectRecipe(option.dataset.recipeId ?? '');
    }

    return (
        <section
            aria-labelledby="execute-catalog-heading"
            className={styles.catalog}
            data-execute-catalog
        >
            <header className={styles.header}>
                <div>
                    <p className={styles.eyebrow}>Repository recipes</p>
                    <h2 id="execute-catalog-heading">Recipe ledger</h2>
                </div>
                <span className={styles.count}>{entries.length} shown</span>
            </header>
            <div className={styles.filters}>
                <label className={styles.field}>
                    <span>Search recipes</span>
                    <input
                        disabled={disabled}
                        onChange={(event) => onQueryChange(event.currentTarget.value)}
                        placeholder="Name, provider, command…"
                        type="search"
                        value={query}
                    />
                </label>
                <label className={styles.field}>
                    <span>Profile</span>
                    <select
                        disabled={disabled}
                        onChange={(event) => onProfileChange(event.currentTarget.value)}
                        value={profile}
                    >
                        <option value="">All profiles</option>
                        {profiles.map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                </label>
            </div>
            {selection.issue ? <p className={styles.issue} role="alert">{selection.issue.message}</p> : null}
            <div
                aria-label="Available recipes"
                className={styles.list}
                role="listbox"
            >
                {entries.map((entry, index) => {
                    const recipeId = entry.item.recipe.recipeId;
                    const selected = recipeId === selectedRecipeId;
                    return (
                        <button
                            aria-selected={selected}
                            className={styles.recipe}
                            data-execute-recipe
                            data-recipe-id={recipeId}
                            disabled={disabled}
                            key={entry.item.itemId}
                            onClick={() => onSelectRecipe(recipeId)}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowDown') {
                                    moveSelection(event, 'next');
                                }
                                if (event.key === 'ArrowUp') {
                                    moveSelection(event, 'previous');
                                }
                                if (event.key === 'Home') {
                                    moveSelection(event, 'first');
                                }
                                if (event.key === 'End') {
                                    moveSelection(event, 'last');
                                }
                            }}
                            role="option"
                            tabIndex={selected || (!selectedVisible && index === 0) ? 0 : -1}
                            type="button"
                        >
                            <span className={styles.selectionRail} />
                            <span className={styles.recipeBody}>
                                <span className={styles.recipeHeading}>
                                    <strong>{entry.item.title}</strong>
                                    <code>{recipeId}</code>
                                </span>
                                <span className={styles.description}>{entry.item.description}</span>
                                <span className={styles.badges}>
                                    <Badge label={entry.item.providerMode} tone="neutral" />
                                    <Badge
                                        label={entry.item.live ? 'Live services' : 'Self-contained'}
                                        tone={entry.item.live ? 'live' : 'neutral'}
                                    />
                                    <Badge
                                        label={entry.schema.label}
                                        tone={entry.schema.ok ? 'good' : 'bad'}
                                    />
                                    <Badge
                                        label={preflightLabel(entry)}
                                        tone={entry.preflight.errors.length > 0
                                            ? 'bad'
                                            : entry.preflight.warnings.length > 0
                                            ? 'warn'
                                            : 'good'}
                                    />
                                </span>
                            </span>
                        </button>
                    );
                })}
                {entries.length === 0
                    ? <p className={styles.empty}>No repository recipe matches these filters.</p>
                    : null}
            </div>
        </section>
    );
}

function Badge({ label, tone }: Readonly<{
    label: string;
    tone: 'neutral' | 'live' | 'good' | 'warn' | 'bad';
}>) {
    return <span className={styles.badge} data-tone={tone}>{label}</span>;
}

function preflightLabel(entry: DistributedRecipeCatalogEntryProjection): string {
    if (entry.preflight.errors.length > 0) {
        return `${entry.preflight.errors.length} preflight error${entry.preflight.errors.length === 1 ? '' : 's'}`;
    }
    if (entry.preflight.warnings.length > 0) {
        return `${entry.preflight.warnings.length} preflight warning${
            entry.preflight.warnings.length === 1 ? '' : 's'
        }`;
    }
    return 'Preflight ready';
}
