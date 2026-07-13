import { useState, type FormEvent } from 'react';
import type { DistributedArtifactEvidenceEntry } from '@shared-test/rallar-bb-test/mod.ts';
import {
    RECIPE_CONSOLE_DIAGNOSTIC_SEVERITIES,
    RECIPE_CONSOLE_RUN_STATUSES,
    RECIPE_CONSOLE_TRANSPORTS,
    RECIPE_CONSOLE_URL_STRING_MAX_BYTES,
    type RecipeConsoleUrlState,
} from '../routing/url-state-contract.ts';
import type { AnalyzeWorkspaceController } from './use-analyze-workspace.ts';
import {
    ANALYZE_SEARCH_ERROR_ID,
    readAnalyzeSearchForm,
    type AnalyzeSearchFormError,
} from './analyze-search-form-boundary.ts';
import { AnalyzeEvidenceFilterSelect } from './AnalyzeEvidenceFilterSelect.tsx';
import { AnalyzeEvidenceResults } from './AnalyzeEvidenceResults.tsx';
import styles from './AnalyzeSearch.module.css';

export function AnalyzeEvidenceSearch({
    controller,
    urlState,
    onInspect,
}: Readonly<{
    controller: AnalyzeWorkspaceController;
    urlState: RecipeConsoleUrlState;
    onInspect?(trigger: HTMLElement): void;
}>) {
    const result = controller.searchResult;
    const [searchError, setSearchError] = useState<AnalyzeSearchFormError>();
    const [formRevision, setFormRevision] = useState(0);
    const formKey = [
        urlState.historyQuery,
        urlState.agentId,
        urlState.recipeId,
        urlState.commandId,
        formRevision,
    ].join('\u0000');

    function submitSearch(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        const submitted = readAnalyzeSearchForm(new FormData(event.currentTarget));
        if (!submitted.ok) {
            setSearchError(submitted.error);
            return;
        }
        setSearchError(undefined);
        controller.updateFilters(submitted.patch);
    }

    function clearSearch(): void {
        setSearchError(undefined);
        setFormRevision(revision => revision + 1);
        controller.clearFilters();
    }

    function activate(
        entry: DistributedArtifactEvidenceEntry,
        trigger: HTMLButtonElement,
        rangeFallback: HTMLElement | null,
    ): void {
        controller.selectEvidence(entry.id);
        const agentId = entry.agentId ??
            (entry.agentIds?.length === 1 ? entry.agentIds[0] : undefined);
        const patch = compact({
            agentId,
            recipeId: entry.recipeId,
            commandId: entry.commandId,
        });
        const invalidatesCurrentQuery = Object.entries(patch).some(
            ([key, value]) => urlState[key as keyof RecipeConsoleUrlState] !== value,
        );
        if (Object.keys(patch).length > 0) controller.updateFilters(patch);
        onInspect?.(
            invalidatesCurrentQuery && rangeFallback
                ? rangeFallback
                : trigger,
        );
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
                <span data-analyze-search-status>
                    {result
                        ? `${result.totalMatches} matches`
                        : controller.evidenceWindowPending
                            ? 'Search pending'
                            : controller.evidenceWindowError
                                ? 'Search unavailable'
                                : 'Search not started'}
                </span>
            </header>

            <form className={styles.searchForm} key={formKey} onSubmit={submitSearch}>
                <label>
                    <span>Search evidence</span>
                    <input
                        {...searchErrorProps(searchError, 'historyQuery')}
                        defaultValue={urlState.historyQuery ?? ''}
                        maxLength={RECIPE_CONSOLE_URL_STRING_MAX_BYTES}
                        name="query"
                        placeholder="Agent, topic, diagnostic, payload…"
                        type="search"
                    />
                </label>
                <label>
                    <span>Agent</span>
                    <input
                        {...searchErrorProps(searchError, 'agentId')}
                        defaultValue={urlState.agentId ?? ''}
                        maxLength={RECIPE_CONSOLE_URL_STRING_MAX_BYTES}
                        name="agentId"
                    />
                </label>
                <label>
                    <span>Recipe</span>
                    <input
                        {...searchErrorProps(searchError, 'recipeId')}
                        defaultValue={urlState.recipeId ?? ''}
                        maxLength={RECIPE_CONSOLE_URL_STRING_MAX_BYTES}
                        name="recipeId"
                    />
                </label>
                <label>
                    <span>Command</span>
                    <input
                        {...searchErrorProps(searchError, 'commandId')}
                        defaultValue={urlState.commandId ?? ''}
                        maxLength={RECIPE_CONSOLE_URL_STRING_MAX_BYTES}
                        name="commandId"
                    />
                </label>
                <button type="submit">Apply search</button>
            </form>

            {searchError ? (
                <p
                    className={styles.searchError}
                    data-analyze-search-error
                    id={ANALYZE_SEARCH_ERROR_ID}
                    role="alert"
                >
                    {searchError.message}
                </p>
            ) : null}

            <div className={styles.filterBar} aria-label="Evidence filters">
                <AnalyzeEvidenceFilterSelect
                    label="Status"
                    onChange={status => controller.updateFilters({
                        status: status as RecipeConsoleUrlState['status'],
                    })}
                    options={RECIPE_CONSOLE_RUN_STATUSES}
                    value={urlState.status}
                />
                <AnalyzeEvidenceFilterSelect
                    label="Severity"
                    onChange={diagnosticSeverity => controller.updateFilters({
                        diagnosticSeverity: diagnosticSeverity as RecipeConsoleUrlState['diagnosticSeverity'],
                    })}
                    options={RECIPE_CONSOLE_DIAGNOSTIC_SEVERITIES}
                    value={urlState.diagnosticSeverity}
                />
                <AnalyzeEvidenceFilterSelect
                    label="Transport"
                    onChange={transport => controller.updateFilters({
                        transport: transport as RecipeConsoleUrlState['transport'],
                    })}
                    options={RECIPE_CONSOLE_TRANSPORTS}
                    value={urlState.transport}
                />
                <button onClick={clearSearch} type="button">Clear filters</button>
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

            <AnalyzeEvidenceResults controller={controller} onActivate={activate} />
        </section>
    );
}

function dateTimeValue(epochMs: number | undefined): string {
    if (epochMs === undefined) return '';
    const date = new Date(epochMs);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(epochMs - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
}

function searchErrorProps(
    error: AnalyzeSearchFormError | undefined,
    field: AnalyzeSearchFormError['field'],
) {
    return error?.field === field
        ? { 'aria-describedby': ANALYZE_SEARCH_ERROR_ID, 'aria-invalid': true }
        : {};
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
