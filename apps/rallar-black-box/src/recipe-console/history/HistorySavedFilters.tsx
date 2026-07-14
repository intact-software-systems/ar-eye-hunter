import { useState, type FormEvent } from 'react';
import {
    HISTORY_FILTER_PRESET_LIMITS,
    type HistoryFilterPreset,
} from './history-filter-contract.ts';
import type {
    HistoryFilterPresetController,
    HistoryFilterPresetControllerStatus,
} from './use-history-filter-presets.ts';
import styles from './HistorySavedFilters.module.css';
import { historyUtcDisplay } from './history-utc.ts';

export type HistorySavedFiltersProps = Readonly<{
    controller: HistoryFilterPresetController;
    onApply(preset: HistoryFilterPreset): void;
}>;

export function HistorySavedFilters({
    controller,
    onApply,
}: HistorySavedFiltersProps) {
    const [nameDraft, setNameDraft] = useState('');
    const storageBlocked = controller.status === 'unsupported' ||
        controller.status === 'unavailable';

    function save(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        controller.save(nameDraft);
        setNameDraft('');
    }

    return (
        <section
            aria-labelledby="history-saved-filter-heading"
            className={styles.panel}
            data-history-saved-filters
        >
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>Saved views</p>
                    <h3 id="history-saved-filter-heading">History filter presets</h3>
                </div>
                <p aria-live="polite" role="status">
                    {statusMessage(controller.status)}
                </p>
            </header>

            <form className={styles.saveForm} onSubmit={save}>
                <label className={styles.field}>
                    <span>Preset name</span>
                    <input
                        disabled={storageBlocked}
                        maxLength={HISTORY_FILTER_PRESET_LIMITS.name}
                        onChange={event => setNameDraft(event.currentTarget.value)}
                        placeholder="e.g. Failed readiness"
                        value={nameDraft}
                    />
                </label>
                <button disabled={storageBlocked} type="submit">
                    Save current filters
                </button>
            </form>

            <details className={styles.disclosure} open>
                <summary>Saved filters ({controller.presets.length})</summary>
                {controller.presets.length > 0 ? (
                    <ul className={styles.list}>
                        {controller.presets.map(preset => (
                            <li className={styles.preset} key={preset.name}>
                                <span className={styles.presetText}>
                                    <strong>{preset.name}</strong>
                                    <small>{presetSummary(preset)}</small>
                                </span>
                                <span className={styles.actions}>
                                    <button
                                        aria-label={`Apply ${preset.name}`}
                                        onClick={() => onApply(preset)}
                                        type="button"
                                    >
                                        Apply
                                    </button>
                                    <button
                                        aria-label={`Delete ${preset.name}`}
                                        disabled={storageBlocked}
                                        onClick={() => controller.remove(preset.name)}
                                        type="button"
                                    >
                                        Delete
                                    </button>
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className={styles.empty}>No saved filters yet.</p>
                )}
            </details>
        </section>
    );
}

function statusMessage(status: HistoryFilterPresetControllerStatus): string {
    switch (status) {
        case 'ready': return 'Saved filters ready';
        case 'invalid': return 'Saved filters need attention';
        case 'unsupported': return 'Saved filters use a newer format';
        case 'unavailable': return 'Saved filters unavailable';
        case 'write-failed': return 'Could not save filters';
    }
}

function presetSummary(preset: HistoryFilterPreset): string {
    const filters = preset.filters;
    const parts = [
        filters.historyQuery && `Query: ${filters.historyQuery}`,
        filters.historyGroup && `Group: ${filters.historyGroup}`,
        filters.historyRecipeId && `Recipe: ${filters.historyRecipeId}`,
        filters.historyProfile && `Profile: ${filters.historyProfile}`,
        filters.failureCategory && `Failure: ${filters.failureCategory}`,
        filters.status && `Status: ${filters.status}`,
        filters.from !== undefined && `From: ${historyUtcDisplay(filters.from)}`,
        filters.to !== undefined && `To: ${historyUtcDisplay(filters.to)}`,
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(' · ') : 'All history';
}
