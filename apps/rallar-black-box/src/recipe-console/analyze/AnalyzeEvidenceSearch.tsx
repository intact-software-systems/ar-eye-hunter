import type { FormEvent } from 'react';
import type { DistributedArtifactEvidenceEntry } from '@shared-test/rallar-bb-test/mod.ts';
import {
    RECIPE_CONSOLE_DIAGNOSTIC_SEVERITIES,
    RECIPE_CONSOLE_RUN_STATUSES,
    RECIPE_CONSOLE_TRANSPORTS,
    type RecipeConsoleUrlState,
} from '../routing/url-state-contract.ts';
import type { AnalyzeWorkspaceController } from './use-analyze-workspace.ts';
import styles from './AnalyzeSearch.module.css';

export function AnalyzeEvidenceSearch({
    controller,
    urlState,
    onInspect,
}: Readonly<{
    controller: AnalyzeWorkspaceController;
    urlState: RecipeConsoleUrlState;
    onInspect?(trigger: HTMLButtonElement): void;
}>) {
    const result = controller.searchResult;
    const formKey = [
        urlState.historyQuery,
        urlState.agentId,
        urlState.recipeId,
        urlState.commandId,
    ].join('\u0000');

    function submitSearch(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        controller.updateFilters({
            historyQuery: value(data, 'query'),
            agentId: value(data, 'agentId'),
            recipeId: value(data, 'recipeId'),
            commandId: value(data, 'commandId'),
        });
    }

    function activate(
        entry: DistributedArtifactEvidenceEntry,
        trigger: HTMLButtonElement,
    ): void {
        controller.selectEvidence(entry.id);
        const agentId = entry.agentId ??
            (entry.agentIds?.length === 1 ? entry.agentIds[0] : undefined);
        const patch = compact({
            agentId,
            recipeId: entry.recipeId,
            commandId: entry.commandId,
        });
        if (Object.keys(patch).length > 0) controller.updateFilters(patch);
        onInspect?.(trigger);
    }

    return (
        <section
            aria-labelledby="analyze-evidence-search-title"
            className={styles.panel}
            data-analyze-evidence-search
            data-analyze-section="search"
        >
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>Evidence search</p>
                    <h2 id="analyze-evidence-search-title">Find the signal behind the verdict</h2>
                    <p>Search normalized failures, results, events, and diagnostics.</p>
                </div>
                <span>{result?.totalMatches ?? 0} matches</span>
            </header>

            <form className={styles.searchForm} key={formKey} onSubmit={submitSearch}>
                <label>
                    <span>Search evidence</span>
                    <input
                        defaultValue={urlState.historyQuery ?? ''}
                        name="query"
                        placeholder="Agent, topic, diagnostic, payload…"
                        type="search"
                    />
                </label>
                <label>
                    <span>Agent</span>
                    <input defaultValue={urlState.agentId ?? ''} name="agentId" />
                </label>
                <label>
                    <span>Recipe</span>
                    <input defaultValue={urlState.recipeId ?? ''} name="recipeId" />
                </label>
                <label>
                    <span>Command</span>
                    <input defaultValue={urlState.commandId ?? ''} name="commandId" />
                </label>
                <button type="submit">Apply search</button>
            </form>

            <div className={styles.filterBar} aria-label="Evidence filters">
                <FilterSelect
                    label="Status"
                    onChange={status => controller.updateFilters({
                        status: status as RecipeConsoleUrlState['status'],
                    })}
                    options={RECIPE_CONSOLE_RUN_STATUSES}
                    value={urlState.status}
                />
                <FilterSelect
                    label="Severity"
                    onChange={diagnosticSeverity => controller.updateFilters({
                        diagnosticSeverity: diagnosticSeverity as RecipeConsoleUrlState['diagnosticSeverity'],
                    })}
                    options={RECIPE_CONSOLE_DIAGNOSTIC_SEVERITIES}
                    value={urlState.diagnosticSeverity}
                />
                <FilterSelect
                    label="Transport"
                    onChange={transport => controller.updateFilters({
                        transport: transport as RecipeConsoleUrlState['transport'],
                    })}
                    options={RECIPE_CONSOLE_TRANSPORTS}
                    value={urlState.transport}
                />
                <button onClick={controller.clearFilters} type="button">Clear filters</button>
            </div>

            <div className={styles.timeFilters} aria-label="Evidence time window">
                <label>
                    <span>From</span>
                    <input
                        onChange={event => controller.updateFilters({
                            from: dateTimeEpoch(event.currentTarget.value),
                        }, true)}
                        type="datetime-local"
                        value={dateTimeValue(urlState.from)}
                    />
                </label>
                <label>
                    <span>To</span>
                    <input
                        onChange={event => controller.updateFilters({
                            to: dateTimeEpoch(event.currentTarget.value),
                        }, true)}
                        type="datetime-local"
                        value={dateTimeValue(urlState.to)}
                    />
                </label>
            </div>

            {result && (!result.totalMatchesIsComplete ||
                result.upstreamOmittedEntryCount > 0) ? (
                <p className={styles.incomplete} data-analyze-index-incomplete role="note">
                    The artifact index was bounded before search. At least
                    {' '}{result.upstreamOmittedEntryCount} upstream entries are omitted;
                    totals may be incomplete.
                </p>
            ) : null}

            <div className={styles.resultSummary} aria-live="polite">
                <span>
                    Showing {result?.entries.length ?? 0} of {result?.totalMatches ?? 0}
                    {result?.totalMatchesIsComplete === false ? '+' : ''}
                </span>
                {result?.omittedMatchCount ? (
                    <span>{result.omittedMatchCount} matching rows omitted by the result limit</span>
                ) : null}
            </div>

            {result && result.entries.length > 0 ? (
                <ol className={styles.results} aria-label="Artifact evidence results">
                    {result.entries.map(entry => (
                        <li key={entry.id}>
                            <button
                                aria-pressed={controller.selectedEvidence?.id === entry.id}
                                className={styles.resultButton}
                                data-evidence-id={entry.id}
                                data-evidence-kind={entry.kind}
                                data-evidence-result
                                data-evidence-source={entry.sourceFile}
                                onClick={event => activate(entry, event.currentTarget)}
                                type="button"
                            >
                                <strong>{entry.summary}</strong>
                                <small>{entry.kind} · {entry.sourceFile}</small>
                                <span className={styles.resultMeta}>
                                    {evidenceMetadata(entry).map(item => (
                                        <span key={item}>{item}</span>
                                    ))}
                                </span>
                            </button>
                        </li>
                    ))}
                </ol>
            ) : (
                <p className={styles.empty} data-analyze-no-evidence>
                    {controller.model
                        ? 'No evidence matches the current filters.'
                        : 'Import or load an artifact to search its evidence.'}
                </p>
            )}
        </section>
    );
}

function FilterSelect({
    label,
    options,
    value: selected,
    onChange,
}: Readonly<{
    label: string;
    options: readonly string[];
    value?: string;
    onChange(value: string | undefined): void;
}>) {
    return (
        <label>
            <span>{label}</span>
            <select
                aria-label={`${label} filter`}
                onChange={event => onChange(event.target.value || undefined)}
                value={selected ?? ''}
            >
                <option value="">Any {label.toLowerCase()}</option>
                {options.map(option => (
                    <option key={option} value={option}>{option}</option>
                ))}
            </select>
        </label>
    );
}

function value(data: FormData, name: string): string | undefined {
    const entry = data.get(name);
    if (typeof entry !== 'string') return undefined;
    const trimmed = entry.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function dateTimeValue(epochMs: number | undefined): string {
    if (epochMs === undefined) return '';
    const date = new Date(epochMs);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(epochMs - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
}

function dateTimeEpoch(value: string): number | undefined {
    if (!value) return undefined;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
}

function compact(
    patch: Partial<RecipeConsoleUrlState>,
): Partial<RecipeConsoleUrlState> {
    return Object.fromEntries(
        Object.entries(patch).filter(([, entry]) => entry !== undefined),
    );
}

function evidenceMetadata(
    entry: DistributedArtifactEvidenceEntry,
): readonly string[] {
    return [
        entry.agentId ?? entry.agentIds?.join(', '),
        entry.recipeId,
        entry.commandId,
        entry.topic,
        entry.diagnosticType,
        entry.status,
        entry.severity,
        entry.transport,
        entry.atEpochMs === undefined
            ? undefined
            : new Date(entry.atEpochMs).toISOString(),
    ].filter((item): item is string => Boolean(item));
}
