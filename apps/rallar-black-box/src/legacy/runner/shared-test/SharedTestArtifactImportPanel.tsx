import { type ChangeEvent, useState } from 'react';
import {
    RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT,
    parseRallarBlackBoxSharedTestArtifactBundle,
    type RallarBlackBoxSharedTestArtifactBundleFiles,
} from '../../../shared-test-handoff-fixtures.ts';
import { Metric } from '../../shared/Metric.tsx';
import { json } from '../../shared/json-presentation.ts';
import { artifactIssueText } from '../shared/artifact-issue-presentation.ts';

const SHARED_TEST_ARTIFACT_FILE_NAMES = [
    ...RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT.requiredFiles,
    ...RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT.optionalFiles,
] as const;

function artifactEventTitle(event: Record<string, unknown>): string {
    return String(event.name ?? event.connection ?? event.kind ?? 'event');
}

function artifactEventDetail(event: Record<string, unknown>): string {
    return (
        [event.status, event.transport, event.action, event.connection]
            .filter(Boolean)
            .join(' - ') || '-'
    );
}

export function SharedTestArtifactImportPanel() {
    const [files, setFiles] =
        useState<RallarBlackBoxSharedTestArtifactBundleFiles>({});
    const [parseResult, setParseResult] = useState<
        | ReturnType<typeof parseRallarBlackBoxSharedTestArtifactBundle>
        | undefined
    >();
    const [readError, setReadError] = useState<string | undefined>();
    const parsed = parseResult?.value;
    const acceptedFileNames = new Set<string>(SHARED_TEST_ARTIFACT_FILE_NAMES);

    const parseFiles = (
        nextFiles: RallarBlackBoxSharedTestArtifactBundleFiles,
    ): void => {
        setFiles(nextFiles);
        setParseResult(parseRallarBlackBoxSharedTestArtifactBundle(nextFiles));
    };

    const handleFiles = async (
        event: ChangeEvent<HTMLInputElement>,
    ): Promise<void> => {
        setReadError(undefined);
        const selectedFiles = Array.from(event.target.files ?? []);
        const nextFiles: RallarBlackBoxSharedTestArtifactBundleFiles = {};

        try {
            for (const file of selectedFiles) {
                if (!acceptedFileNames.has(file.name)) {
                    continue;
                }
                nextFiles[
                    file.name as keyof RallarBlackBoxSharedTestArtifactBundleFiles
                ] = await file.text();
            }
            parseFiles(nextFiles);
        } catch (error) {
            setReadError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    const copyReplayRecipe = (): void => {
        if (parsed?.views.replayRecipe) {
            void navigator.clipboard?.writeText(
                json(parsed.views.replayRecipe),
            );
        }
    };

    const loadedFiles = Object.keys(files).length;

    return (
        <section className="panel shared-test-artifact-panel">
            <div className="panel-heading">
                <h2>Artifact Import</h2>
                <span
                    className={`pill ${parseResult?.ok ? 'good' : parseResult ? 'bad' : 'muted'}`}
                >
                    {parseResult?.ok
                        ? 'valid'
                        : parseResult
                          ? 'invalid'
                          : 'idle'}
                </span>
            </div>
            <div className="artifact-import-controls">
                <label className="field">
                    <span>Artifact Files</span>
                    <input
                        type="file"
                        multiple
                        accept=".json,.jsonl,application/json"
                        onChange={(event) => void handleFiles(event)}
                    />
                </label>
                <button
                    type="button"
                    onClick={() => parseFiles(files)}
                    disabled={loadedFiles === 0}
                >
                    Validate Bundle
                </button>
            </div>
            <div className="artifact-file-grid">
                {SHARED_TEST_ARTIFACT_FILE_NAMES.map((fileName) => {
                    const required =
                        RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT.requiredFiles.includes(
                            fileName,
                        );
                    const loaded = files[fileName] !== undefined;
                    return (
                        <div
                            key={fileName}
                            className={`artifact-file-row ${loaded ? 'loaded' : ''}`}
                        >
                            <strong>{fileName}</strong>
                            <span
                                className={`pill ${loaded ? 'good' : required ? 'bad' : 'muted'}`}
                            >
                                {loaded
                                    ? 'loaded'
                                    : required
                                      ? 'required'
                                      : 'optional'}
                            </span>
                        </div>
                    );
                })}
            </div>
            {(readError || (parseResult && parseResult.issues.length > 0)) && (
                <div className="artifact-issue-list" role="status">
                    {readError && (
                        <div className="workbench-error">{readError}</div>
                    )}
                    {parseResult?.issues.map((issue, index) => (
                        <div
                            className={`artifact-issue-row ${issue.severity}`}
                            key={`${issue.severity}-${issue.file ?? 'bundle'}-${issue.path}-${index}`}
                        >
                            <strong>{issue.severity}</strong>
                            <span>{artifactIssueText(issue)}</span>
                        </div>
                    ))}
                </div>
            )}
            {parsed && (
                <div className="artifact-view-grid">
                    <section className="shared-test-subpanel artifact-summary-panel">
                        <div className="section-heading">
                            <h3>Imported Summary</h3>
                            <span>schema {parsed.schemaVersion}</span>
                        </div>
                        <div className="shared-test-summary-grid">
                            <Metric
                                label="Total"
                                value={String(parsed.report.summary.total)}
                            />
                            <Metric
                                label="Success"
                                value={String(parsed.report.summary.success)}
                                tone="good"
                            />
                            <Metric
                                label="Failure"
                                value={String(parsed.report.summary.failure)}
                                tone={
                                    parsed.report.summary.failure > 0
                                        ? 'bad'
                                        : 'good'
                                }
                            />
                            <Metric
                                label="Events"
                                value={String(parsed.views.eventStream.length)}
                            />
                            <Metric
                                label="RTC diagnostics"
                                value={String(
                                    parsed.views.rtcDiagnostics.length,
                                )}
                            />
                            <Metric
                                label="RTC messages"
                                value={String(parsed.views.rtcMessages.length)}
                            />
                            <Metric
                                label="WS messages"
                                value={String(parsed.views.wsMessages.length)}
                            />
                            <Metric
                                label="Replay"
                                value={
                                    parsed.views.replayRecipe
                                        ? 'available'
                                        : 'none'
                                }
                                tone={
                                    parsed.views.replayRecipe ? 'good' : 'muted'
                                }
                            />
                        </div>
                    </section>
                    <section className="shared-test-subpanel">
                        <div className="section-heading">
                            <h3>Imported Event Stream</h3>
                            <span>
                                {parsed.views.eventStream.length} events
                            </span>
                        </div>
                        <div className="artifact-event-list">
                            {parsed.views.eventStream
                                .slice(0, 24)
                                .map((event, index) => (
                                    <article
                                        className="event-row"
                                        key={`${event.kind}-${index}`}
                                    >
                                        <div className="event-topline">
                                            <span className="pill muted">
                                                {event.kind}
                                            </span>
                                            <strong>
                                                {artifactEventTitle(event)}
                                            </strong>
                                        </div>
                                        <div className="event-meta">
                                            <span>
                                                {artifactEventDetail(event)}
                                            </span>
                                        </div>
                                    </article>
                                ))}
                        </div>
                    </section>
                    <section className="shared-test-subpanel">
                        <div className="section-heading">
                            <h3>Imported RTC Diagnostics</h3>
                            <span>
                                {parsed.views.rtcDiagnostics.length} events
                            </span>
                        </div>
                        <pre className="json-block">
                            {json(parsed.views.rtcDiagnostics.slice(0, 12))}
                        </pre>
                    </section>
                    <section className="shared-test-subpanel">
                        <div className="section-heading">
                            <h3>Imported Failure Focus</h3>
                            <span>{parsed.views.failures.length} failures</span>
                        </div>
                        <pre className="json-block">
                            {json(parsed.views.failures.slice(0, 12))}
                        </pre>
                    </section>
                    {parsed.views.replayRecipe && (
                        <section className="shared-test-subpanel artifact-replay-panel">
                            <div className="section-heading">
                                <h3>Replay Recipe</h3>
                                <button
                                    type="button"
                                    onClick={copyReplayRecipe}
                                >
                                    Copy Replay
                                </button>
                            </div>
                            <pre className="json-block">
                                {json(parsed.views.replayRecipe)}
                            </pre>
                        </section>
                    )}
                </div>
            )}
        </section>
    );
}
