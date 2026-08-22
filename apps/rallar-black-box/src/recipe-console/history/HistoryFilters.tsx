import { useEffect, useState, type FormEvent } from 'react';
import {
    RECIPE_CONSOLE_FAILURE_CATEGORIES,
    RECIPE_CONSOLE_RUN_STATUSES,
    type RecipeConsoleFailureCategory,
    type RecipeConsoleRunStatus,
    type RecipeConsoleUrlState
} from '../routing/url-state-contract.ts';
import {
    HISTORY_FILTER_PRESET_LIMITS,
    historyFilterPresetApplyPatch,
    type HistoryFilterValues
} from './history-filter-contract.ts';
import { historyUtcInputEpoch, historyUtcInputValue } from './history-utc.ts';
import styles from './HistoryFilters.module.css';

export type HistoryFiltersProps = Readonly<{
    urlState: RecipeConsoleUrlState;
    resetRevision: number;
    onApply(patch: Partial<RecipeConsoleUrlState>): void;
    onReset(patch: Partial<RecipeConsoleUrlState>): void;
}>;

type HistoryFilterDraft = Readonly<{
    historyQuery: string;
    historyGroup: string;
    historyRecipeId: string;
    historyProfile: string;
    failureCategory: string;
    status: string;
    from: string;
    to: string;
}>;

const EMPTY_DRAFT: HistoryFilterDraft = {
    historyQuery: '',
    historyGroup: '',
    historyRecipeId: '',
    historyProfile: '',
    failureCategory: '',
    status: '',
    from: '',
    to: ''
};

export function HistoryFilters({
    urlState,
    resetRevision,
    onApply,
    onReset
}: HistoryFiltersProps) {
    const [draft, setDraft] = useState<HistoryFilterDraft>(
        () => draftFromUrlState(urlState)
    );

    useEffect(() => {
        setDraft(draftFromUrlState(urlState));
    }, [
        urlState.historyQuery,
        urlState.historyGroup,
        urlState.historyRecipeId,
        urlState.historyProfile,
        urlState.failureCategory,
        urlState.status,
        urlState.from,
        urlState.to,
        resetRevision
    ]);

    function updateDraft(key: keyof HistoryFilterDraft, value: string): void {
        setDraft((current) => ({ ...current, [key]: value }));
    }

    function apply(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        onApply(replacementPatch(draft));
    }

    function reset(): void {
        setDraft(EMPTY_DRAFT);
        onReset(replacementPatch(EMPTY_DRAFT));
    }

    return (
        <section
            aria-labelledby="history-filter-heading"
            className={styles.panel}
            data-history-filters
        >
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>History filters</p>
                    <h3 id="history-filter-heading">Find a previous run</h3>
                </div>
                <p>Draft changes stay local until applied.</p>
            </header>

            <form className={styles.form} onSubmit={apply}>
                <div className={styles.grid}>
                    <TextField
                        label="Query"
                        maxLength={HISTORY_FILTER_PRESET_LIMITS.query}
                        onChange={(value) => updateDraft('historyQuery', value)}
                        placeholder="Failure, run, agent…"
                        type="search"
                        value={draft.historyQuery}
                    />
                    <TextField
                        label="Group"
                        maxLength={HISTORY_FILTER_PRESET_LIMITS.string}
                        onChange={(value) => updateDraft('historyGroup', value)}
                        value={draft.historyGroup}
                    />
                    <TextField
                        label="Recipe"
                        maxLength={HISTORY_FILTER_PRESET_LIMITS.string}
                        onChange={(value) => updateDraft('historyRecipeId', value)}
                        value={draft.historyRecipeId}
                    />
                    <TextField
                        label="Profile"
                        maxLength={HISTORY_FILTER_PRESET_LIMITS.string}
                        onChange={(value) => updateDraft('historyProfile', value)}
                        value={draft.historyProfile}
                    />
                    <SelectField
                        label="Failure category"
                        onChange={(value) => updateDraft('failureCategory', value)}
                        options={RECIPE_CONSOLE_FAILURE_CATEGORIES}
                        placeholder="All categories"
                        value={draft.failureCategory}
                    />
                    <SelectField
                        label="Run status"
                        onChange={(value) => updateDraft('status', value)}
                        options={RECIPE_CONSOLE_RUN_STATUSES}
                        placeholder="All statuses"
                        value={draft.status}
                    />
                    <TextField
                        label="From (UTC)"
                        onChange={(value) => updateDraft('from', value)}
                        step="0.001"
                        type="datetime-local"
                        value={draft.from}
                    />
                    <TextField
                        label="To (UTC)"
                        onChange={(value) => updateDraft('to', value)}
                        step="0.001"
                        type="datetime-local"
                        value={draft.to}
                    />
                </div>
                <div className={styles.actions}>
                    <button onClick={reset} type="button">Reset</button>
                    <button className={styles.primary} type="submit">Apply filters</button>
                </div>
            </form>
        </section>
    );
}

function TextField({
    label,
    maxLength,
    onChange,
    placeholder,
    step,
    type = 'text',
    value
}: Readonly<{
    label: string;
    maxLength?: number;
    onChange(value: string): void;
    placeholder?: string;
    step?: string;
    type?: 'text' | 'search' | 'datetime-local';
    value: string;
}>) {
    return (
        <label className={styles.field}>
            <span>{label}</span>
            <input
                maxLength={maxLength}
                onChange={(event) => onChange(event.currentTarget.value)}
                placeholder={placeholder}
                step={step}
                type={type}
                value={value}
            />
        </label>
    );
}

function SelectField({
    label,
    onChange,
    options,
    placeholder,
    value
}: Readonly<{
    label: string;
    onChange(value: string): void;
    options: readonly string[];
    placeholder: string;
    value: string;
}>) {
    return (
        <label className={styles.field}>
            <span>{label}</span>
            <select
                onChange={(event) => onChange(event.currentTarget.value)}
                value={value}
            >
                <option value="">{placeholder}</option>
                {options.map((option) => <option key={option} value={option}>{displayEnum(option)}</option>)}
            </select>
        </label>
    );
}

function draftFromUrlState(state: RecipeConsoleUrlState): HistoryFilterDraft {
    return {
        historyQuery: state.historyQuery ?? '',
        historyGroup: state.historyGroup ?? '',
        historyRecipeId: state.historyRecipeId ?? '',
        historyProfile: state.historyProfile ?? '',
        failureCategory: state.failureCategory ?? '',
        status: state.status ?? '',
        from: historyUtcInputValue(state.from),
        to: historyUtcInputValue(state.to)
    };
}

function replacementPatch(draft: HistoryFilterDraft): Partial<RecipeConsoleUrlState> {
    const filters: HistoryFilterValues = {
        historyQuery: normalizedText(draft.historyQuery),
        historyGroup: normalizedText(draft.historyGroup),
        historyRecipeId: normalizedText(draft.historyRecipeId),
        historyProfile: normalizedText(draft.historyProfile),
        failureCategory: optionalFailureCategory(draft.failureCategory),
        status: optionalRunStatus(draft.status),
        from: historyUtcInputEpoch(draft.from),
        to: historyUtcInputEpoch(draft.to)
    };
    return historyFilterPresetApplyPatch({ name: 'Transient draft', filters });
}

function normalizedText(value: string): string | undefined {
    const normalized = value.trim();
    return normalized || undefined;
}

function optionalFailureCategory(
    value: string
): RecipeConsoleFailureCategory | undefined {
    return RECIPE_CONSOLE_FAILURE_CATEGORIES.includes(
            value as RecipeConsoleFailureCategory
        )
        ? value as RecipeConsoleFailureCategory
        : undefined;
}

function optionalRunStatus(value: string): RecipeConsoleRunStatus | undefined {
    return RECIPE_CONSOLE_RUN_STATUSES.includes(value as RecipeConsoleRunStatus)
        ? value as RecipeConsoleRunStatus
        : undefined;
}

function displayEnum(value: string): string {
    return value.split('-').map(
        (part, index) =>
            index === 0
                ? `${part.charAt(0).toUpperCase()}${part.slice(1)}`
                : part
    ).join(' ');
}
