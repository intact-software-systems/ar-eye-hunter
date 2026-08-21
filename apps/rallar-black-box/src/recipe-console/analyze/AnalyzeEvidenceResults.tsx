import type { DistributedArtifactEvidenceEntry } from '@shared-test/rallar-bb-test/mod.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import { useExplicitWindowFocusRecovery } from '../ui/use-explicit-window.ts';
import { deriveAnalyzeEvidenceWindowModel } from './analyze-evidence-window-model.ts';
import { AnalyzeFailureDetails } from './AnalyzeFailureDetails.tsx';
import styles from './AnalyzeSearch.module.css';
import type { AnalyzeWorkspaceController } from './use-analyze-workspace.ts';

const RESULTS_ID = 'analyze-evidence-results';

export function AnalyzeEvidenceResults({
    controller,
    onActivate
}: Readonly<{
    controller: AnalyzeWorkspaceController;
    onActivate(
        entry: DistributedArtifactEvidenceEntry,
        trigger: HTMLButtonElement,
        rangeFallback: HTMLElement | null
    ): void;
}>) {
    const window = controller.evidenceWindow;
    const fingerprint = controller.queryFingerprint ?? 'analyze-evidence';
    const current = window &&
            controller.evidenceWindowFingerprint === controller.queryFingerprint
        ? window
        : undefined;
    const model = deriveAnalyzeEvidenceWindowModel(
        current ?? emptyAnalyzeWindow(),
        fingerprint
    );
    const focus = useExplicitWindowFocusRecovery(model);
    const pending = controller.evidenceWindowPending ?? false;

    return (
        <div
            className={styles.windowRegion}
            data-analyze-evidence-window
            {...focus.contentFocusProps}
        >
            <EvidenceWindowTruth
                error={controller.evidenceWindowError}
                pending={pending}
                window={current}
            />
            <ExplicitWindowControls
                contentId={RESULTS_ID}
                emptyLabel={!current
                    ? pending
                        ? 'Current query range is pending.'
                        : controller.evidenceWindowError
                        ? 'Current query range is unavailable.'
                        : 'Search not started.'
                    : undefined}
                focusFallbackRef={focus.fallbackFocusRef}
                itemLabel="retained matches"
                label="Evidence results"
                model={model}
                onNext={() => requestCursor(controller, current?.nextCursor)}
                onPrevious={() =>
                    requestCursor(
                        controller,
                        current?.previousCursor
                    )}
                pending={pending}
            />
            {controller.evidenceWindowError
                ? (
                    <div className={styles.windowError} data-analyze-window-error role="alert">
                        <p>{controller.evidenceWindowError}</p>
                        <button
                            disabled={pending}
                            onClick={controller.retryEvidenceSearch}
                            type="button"
                        >
                            Retry evidence search
                        </button>
                    </div>
                )
                : null}
            {!current && pending
                ? (
                    <p className={styles.empty} data-analyze-evidence-stale role="status">
                        Searching the active artifact and filters. Prior query rows are not mounted.
                    </p>
                )
                : null}
            <ol
                className={styles.results}
                id={RESULTS_ID}
                aria-label="Artifact evidence results"
            >
                {current?.entries.map((entry) => (
                    <li key={entry.id}>
                        <button
                            aria-pressed={controller.selectedEvidence?.id === entry.id}
                            className={styles.resultButton}
                            data-evidence-id={entry.id}
                            data-evidence-kind={entry.kind}
                            data-evidence-result
                            data-evidence-source={entry.sourceFile}
                            onClick={(event) =>
                                onActivate(
                                    entry,
                                    event.currentTarget,
                                    focus.fallbackFocusRef.current
                                )}
                            type="button"
                        >
                            <strong>{entry.summary}</strong>
                            <small>{entry.kind} · {entry.sourceFile}</small>
                            {entry.kind === 'result' && entry.failureDetails
                                ? (
                                    <AnalyzeFailureDetails
                                        density="row"
                                        details={entry.failureDetails}
                                    />
                                )
                                : null}
                            <EvidenceMetadata entry={entry} />
                        </button>
                    </li>
                ))}
            </ol>
            {!current && !pending && !controller.evidenceWindowError
                ? (
                    <p
                        className={styles.empty}
                        data-analyze-evidence-not-started
                    >
                        {controller.model
                            ? 'Evidence search has not started.'
                            : 'Import or load an artifact to search its evidence.'}
                    </p>
                )
                : null}
            {!current && controller.evidenceWindowError
                ? (
                    <p
                        className={styles.empty}
                        data-analyze-evidence-unavailable
                    >
                        Current query evidence is unavailable. Retry the search; prior query rows are not mounted.
                    </p>
                )
                : null}
            {current && current.entries.length === 0
                ? (
                    <p className={styles.empty} data-analyze-no-evidence>
                        No evidence matches the current filters.
                    </p>
                )
                : null}
        </div>
    );
}

function EvidenceWindowTruth({
    error,
    pending,
    window
}: Readonly<{
    error: string | undefined;
    pending: boolean;
    window: AnalyzeWorkspaceController['evidenceWindow'];
}>) {
    const counts = window?.counts;
    const omitted = counts?.indexOmittedEntries ?? 0;
    const outside = counts?.renderOmittedMatches ?? 0;
    const noWindowTruth = pending
        ? 'Pending current query.'
        : error
        ? 'Unavailable for current query.'
        : 'No current query.';
    const noRenderTruth = pending
        ? 'Current render window pending.'
        : error
        ? 'Current render window unavailable.'
        : 'No current render window.';
    return (
        <dl className={styles.windowTruth} data-analyze-window-truth>
            <div data-analyze-producer-compaction>
                <dt>Producer compaction</dt>
                <dd>Unavailable for distributed artifacts.</dd>
            </div>
            <div data-analyze-index-omission>
                <dt>Index omission</dt>
                <dd>
                    {window
                        ? `${number(omitted)} source entries omitted before search and not searchable.`
                        : noWindowTruth}
                </dd>
            </div>
            <div data-analyze-matching-truth>
                <dt>Matching</dt>
                <dd>
                    {window
                        ? `${number(counts?.retainedMatches ?? 0)} retained matches.`
                        : noWindowTruth}
                </dd>
            </div>
            <div data-analyze-render-window-truth>
                <dt>Render window</dt>
                <dd>
                    {window
                        ? `${number(outside)} outside this render window and browseable.`
                        : noRenderTruth}
                </dd>
            </div>
        </dl>
    );
}

function EvidenceMetadata({
    entry
}: Readonly<{ entry: DistributedArtifactEvidenceEntry; }>) {
    const exact = [
        ...(entry.agentId ? [entry.agentId] : entry.agentIds ?? []),
        ...(entry.recipeId ? [entry.recipeId] : []),
        ...(entry.commandId ? [entry.commandId] : [])
    ];
    const descriptive = [
        entry.topic,
        entry.diagnosticType,
        entry.status,
        entry.severity,
        entry.transport,
        entry.atEpochMs === undefined
            ? undefined
            : new Date(entry.atEpochMs).toISOString()
    ].filter((item): item is string => Boolean(item));
    if (exact.length === 0 && descriptive.length === 0) {
        return null;
    }
    return (
        <span className={styles.resultMeta}>
            {exact.map((value, index) => (
                <span key={`exact-${index}-${value}`}>
                    <ExactIdentifier value={value} />
                </span>
            ))}
            {descriptive.map((value, index) => <span dir="auto" key={`metadata-${index}-${value}`}>{value}</span>)}
        </span>
    );
}

function requestCursor(
    controller: AnalyzeWorkspaceController,
    cursor: string | undefined
): void {
    if (cursor && !controller.evidenceWindowPending) {
        controller.requestWindow(cursor);
    }
}

function number(value: number): string {
    return value.toLocaleString('en-US');
}

function emptyAnalyzeWindow() {
    return {
        entries: [],
        rangeStart: 0,
        rangeEnd: 0,
        counts: {
            totalEntries: 0,
            indexedEntries: 0,
            indexOmittedEntries: 0,
            retainedMatches: 0,
            queryExcludedEntries: 0,
            renderedMatches: 0,
            renderOmittedMatches: 0
        },
        totalMatchesIsComplete: true,
        windowSize: 64
    } as const;
}
