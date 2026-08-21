import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RallarBlackBoxSharedTestParsedArtifactBundle } from '../../../shared-test-handoff-fixtures.ts';
import {
    deriveSharedTestArtifactIndexPresentation,
    deriveSharedTestCompactionSummaryWindow,
    moveSharedTestCompactionSummaryWindow,
    SHARED_TEST_COMPACTION_SUMMARY_WINDOW_SIZE,
    type SharedTestCompactionSummary
} from './shared-test-artifact-index-presentation.ts';
type SharedTestArtifactIndex = NonNullable<
    RallarBlackBoxSharedTestParsedArtifactBundle[
        'views'
    ]['artifactIndex']
>;
export function SharedTestArtifactIndexPanel({
    artifactIndex
}: Readonly<{ artifactIndex: SharedTestArtifactIndex; }>) {
    const summaryListId = `shared-test-compaction-summaries-${useId()}`;
    const rangeFocusRef = useRef<HTMLSpanElement>(null);
    const recoverFocusRef = useRef(false);
    const presentation = useMemo(
        () => deriveSharedTestArtifactIndexPresentation(artifactIndex),
        [artifactIndex]
    );
    const [windowState, setWindowState] = useState(() => ({
        artifactIndex,
        startIndex: 0
    }));
    const requestedStartIndex = windowState.artifactIndex === artifactIndex
        ? windowState.startIndex
        : 0;
    const window = deriveSharedTestCompactionSummaryWindow(
        presentation.compaction.summaries,
        requestedStartIndex
    );
    const showWindow = presentation.compaction.status === 'compacted' &&
        presentation.compaction.summaries.length > 0;
    const compactionMessage = ({
        'metadata-unavailable': 'Compaction metadata unavailable.',
        'flag-invalid': 'Compaction flag is invalid.',
        incoherent: 'Compaction metadata is inconsistent.',
        'not-compacted': 'Producer reports no event compaction.',
        'summaries-unavailable': 'Compaction summaries unavailable.',
        'summaries-invalid': 'Compaction summaries are invalid.',
        'index-inconsistent': 'Artifact-index metadata is inconsistent.',
        compacted: presentation.compaction.summaryCount === 0
            ? '0 compacted success groups reported.'
            : undefined
    } as const)[presentation.compaction.status];
    useLayoutEffect(() => {
        if (!recoverFocusRef.current) {
            return;
        }
        recoverFocusRef.current = false;
        rangeFocusRef.current?.focus();
    }, [window.startIndex]);
    const move = (direction: 'previous' | 'next', focused: boolean): void => {
        const startIndex = moveSharedTestCompactionSummaryWindow(window, direction);
        recoverFocusRef.current = focused && (direction === 'previous'
            ? startIndex === 0
            : startIndex + SHARED_TEST_COMPACTION_SUMMARY_WINDOW_SIZE >= window.total);
        setWindowState({ artifactIndex, startIndex });
    };

    return (
        <section
            className="shared-test-subpanel artifact-summary-panel"
            data-shared-test-artifact-index
        >
            <div className="section-heading">
                <h3>Artifact Index Compaction</h3>
                <span
                    className={`pill ${
                        presentation.truncation.truncated === true
                            ? 'warn'
                            : presentation.truncation.truncated === false
                            ? 'good'
                            : 'muted'
                    }`}
                >
                    {presentation.truncation.truncated === true
                        ? 'truncated'
                        : presentation.truncation.truncated === false
                        ? 'complete'
                        : 'unknown'}
                </span>
            </div>
            <p className="shared-test-description">
                Generic black-box-runner artifact index. Its runner identity is not authoritative distributed-run
                identity.
            </p>
            <div className="shared-test-summary-grid">
                <IndexMetric
                    dataName="data-shared-test-index-total-events"
                    label="Indexed source events"
                    value={presentation.truncation.totalEvents}
                />
                <IndexMetric
                    dataName="data-shared-test-index-emitted-events"
                    label="Emitted source events"
                    value={presentation.truncation.emittedEvents}
                />
                <IndexMetric
                    dataName="data-shared-test-index-omitted-events"
                    label="Producer-omitted events"
                    value={presentation.truncation.omittedEvents}
                />
                <IndexMetric
                    dataName="data-shared-test-index-summary-count"
                    label="Compacted success groups"
                    value={presentation.compaction.summariesAvailable
                        ? presentation.compaction.summaryCount
                        : undefined}
                />
            </div>
            {compactionMessage
                ? (
                    <p className="shared-test-description" role="status">
                        {compactionMessage}
                    </p>
                )
                : null}
            {showWindow
                ? (
                    <>
                        {presentation.compaction.summaries.length >
                                SHARED_TEST_COMPACTION_SUMMARY_WINDOW_SIZE
                            ? (
                                <div
                                    aria-label="Compacted success summary window"
                                    className="heading-actions"
                                    data-shared-test-compaction-window
                                    role="group"
                                >
                                    <button
                                        aria-controls={summaryListId}
                                        disabled={!window.canPrevious}
                                        onClick={(event) =>
                                            move(
                                                'previous',
                                                event.currentTarget.ownerDocument.activeElement === event.currentTarget
                                            )}
                                        type="button"
                                    >
                                        Previous
                                    </button>
                                    <span
                                        aria-atomic="true"
                                        aria-live="polite"
                                        data-shared-test-compaction-range
                                        ref={rangeFocusRef}
                                        role="status"
                                        tabIndex={-1}
                                    >
                                        Showing {number(window.displayStart)}–
                                        {number(window.displayEnd)} of {number(window.total)} compacted success groups.
                                    </span>
                                    <button
                                        aria-controls={summaryListId}
                                        disabled={!window.canNext}
                                        onClick={(event) =>
                                            move(
                                                'next',
                                                event.currentTarget.ownerDocument.activeElement === event.currentTarget
                                            )}
                                        type="button"
                                    >
                                        Next
                                    </button>
                                </div>
                            )
                            : null}
                        <ol
                            className="artifact-event-list"
                            id={summaryListId}
                            start={window.displayStart}
                        >
                            {window.rows.map((summary) => <SummaryRow key={summary.sourceOrdinal} summary={summary} />)}
                        </ol>
                    </>
                )
                : null}
        </section>
    );
}
function IndexMetric({
    dataName,
    label,
    value
}: Readonly<{ dataName: string; label: string; value?: number; }>) {
    return (
        <div className="metric">
            <span>{label}</span>
            <strong className="muted" {...{ [dataName]: '' }}>
                {number(value)}
            </strong>
        </div>
    );
}
function SummaryRow({ summary }: Readonly<{ summary: SharedTestCompactionSummary; }>) {
    return (
        <li
            className="event-row"
            data-compaction-summary-ordinal={summary.sourceOrdinal}
            data-compaction-summary-row
        >
            <div className="event-topline">
                <span className="pill muted">#{summary.sourceOrdinal}</span>
                <strong>
                    <bdi data-compaction-summary-name dir="ltr">{summary.name}</bdi>
                </strong>
            </div>
            <div className="event-meta">
                <span>
                    Transport <ExactValue value={summary.transport} />
                </span>
                <span>
                    Action <ExactValue value={summary.action} />
                </span>
                <span>
                    Connection <ExactValue value={summary.connection} />
                </span>
                <span>Count {number(summary.count)}</span>
                <span>
                    Sequence {number(summary.firstSequence)}–
                    {number(summary.lastSequence)}
                </span>
            </div>
        </li>
    );
}
function ExactValue({ value }: Readonly<{ value?: string; }>) {
    return <bdi dir="ltr">{value ?? 'unknown'}</bdi>;
}
function number(value: number | undefined): string {
    return value === undefined ? 'unknown' : value.toLocaleString('en-US');
}
