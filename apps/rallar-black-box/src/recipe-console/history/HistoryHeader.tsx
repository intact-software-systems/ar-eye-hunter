import { createAnalyzeLegacyRunsHref } from '../analyze/analyze-legacy-links.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { StatusMark, type OperationalStatus } from '../ui/StatusMark.tsx';
import type { RecipeConsoleHistoryProvenance } from './history-model.ts';
import { historyUtcDisplay } from './history-utc.ts';
import styles from './HistoryWorkspace.module.css';

export function HistoryHeader({
    provenance,
    urlState,
    onCopyLink
}: Readonly<{
    provenance: RecipeConsoleHistoryProvenance;
    urlState: RecipeConsoleUrlState;
    onCopyLink(): void;
}>) {
    const sourceSearch = typeof window === 'undefined' ? '' : window.location.search;
    const legacyRunsHref = createAnalyzeLegacyRunsHref({
        v: 1,
        experience: 'recipe-console',
        view: 'tune'
    }, sourceSearch);
    const notice = historyNotice(provenance);
    return (
        <header className={styles.heading}>
            <div className={styles.headingTop}>
                <div className={styles.title}>
                    <h2 id="server-run-history-heading">Server run history</h2>
                    <StatusMark
                        label={provenanceLabel(provenance)}
                        status={provenanceTone(provenance)}
                    />
                </div>
                <div className={styles.actions}>
                    <button onClick={onCopyLink} type="button">
                        Copy filtered link
                    </button>
                    <a href={legacyRunsHref}>Open legacy Runs</a>
                </div>
            </div>
            <p className={styles.summary}>{filterSummary(urlState)}</p>
            {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        </header>
    );
}

function provenanceLabel(value: RecipeConsoleHistoryProvenance): string {
    const source = value.distributedRunsSource === 'root-snapshot'
        ? 'Root snapshot'
        : value.distributedRunsSource === 'canonical-fallback'
        ? 'Canonical fallback'
        : 'Source unavailable';
    return `${source} · ${value.completeness} · ${value.freshness}`;
}

function provenanceTone(value: RecipeConsoleHistoryProvenance): OperationalStatus {
    if (value.status === 'offline') {
        return 'failed';
    }
    if (value.freshness === 'unavailable') {
        return 'disabled';
    }
    if (value.freshness === 'last-known') {
        return 'stale';
    }
    if (value.completeness === 'partial') {
        return 'partial';
    }
    return value.status === 'live' ? 'passed' : 'running';
}

function historyNotice(value: RecipeConsoleHistoryProvenance): string | undefined {
    if (value.freshness === 'last-known') {
        return 'Showing last-known server history while the root query recovers.';
    }
    if (value.completeness === 'partial') {
        return 'History is partial; unavailable evidence is not inferred.';
    }
    return undefined;
}

function filterSummary(state: RecipeConsoleUrlState): string {
    const parts = [
        state.historyQuery && `Text “${state.historyQuery}”`,
        state.historyGroup && `Group ${state.historyGroup}`,
        state.historyRecipeId && `Recipe ${state.historyRecipeId}`,
        state.historyProfile && `Profile ${state.historyProfile}`,
        state.failureCategory && `Failure ${state.failureCategory}`,
        state.status && `Status ${state.status}`,
        state.from !== undefined && `From ${historyUtcDisplay(state.from)}`,
        state.to !== undefined && `To ${historyUtcDisplay(state.to)}`
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(' · ') : 'All server runs';
}
