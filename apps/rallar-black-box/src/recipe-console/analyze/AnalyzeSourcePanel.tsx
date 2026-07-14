import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import type { AnalyzeWorkspaceController } from './use-analyze-workspace.ts';
import styles from './AnalyzeSource.module.css';
const DIRECTORY_INPUT_ATTRIBUTES = {
    directory: '',
    webkitdirectory: '',
} as const;
export function AnalyzeSourcePanel({
    controller,
    legacyRunsHref,
    legacySharedTestHref,
}: Readonly<{
    controller: AnalyzeWorkspaceController;
    legacyRunsHref: string;
    legacySharedTestHref: string;
}>) {
    const filesInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const [dragActive, setDragActive] = useState(false);
    const [announcement, setAnnouncement] = useState(
        'Choose JSON artifact files, a folder, or drop a CI bundle.',
    );
    const importing = controller.busyAction === 'import-local';
    const loading = controller.busyAction === 'load-control';

    async function importSelection(files: readonly File[]): Promise<void> {
        if (files.length === 0) return;
        if (controller.busyAction) {
            setAnnouncement(
                `Artifact selection rejected while ${busyActionLabel(controller.busyAction)} is in progress; dropped files were not read.`,
            );
            return;
        }
        setAnnouncement(`Reading ${files.length} selected file${files.length === 1 ? '' : 's'}.`);
        const accepted = await controller.importFiles(files);
        setAnnouncement(current => isBusyRejection(current)
            ? current
            : accepted
            ? 'Artifact selection ready. Review the verdict and file inventory.'
            : `Artifact selection rejected. ${controller.model
                ? 'Previous analysis retained.'
                : 'No artifact was loaded.'}`);
    }

    async function loadControlArtifact(): Promise<void> {
        setAnnouncement('Control artifact load started.');
        const accepted = await controller.loadControlArtifact();
        if (!accepted) {
            setAnnouncement(`Control artifact load failed. ${controller.model
                ? 'Previous analysis retained.'
                : 'No artifact was loaded.'}`);
        }
    }

    function selectFiles(event: ChangeEvent<HTMLInputElement>): void {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = '';
        void importSelection(files);
    }

    function dropFiles(event: DragEvent<HTMLDivElement>): void {
        event.preventDefault();
        setDragActive(false);
        void importSelection(Array.from(event.dataTransfer.files));
    }

    const missingControlOption = Boolean(
        controller.controlRunId &&
        !controller.controlRunOptions.some(run =>
            run.runId === controller.controlRunId
        ),
    );
    const missingDistributedOption = Boolean(
        controller.distributedRunId &&
        !controller.distributedRunOptions.some(run =>
            run.distributedRunId === controller.distributedRunId
        ),
    );

    return (
        <section
            aria-busy={Boolean(controller.busyAction)}
            aria-labelledby="analyze-source-title"
            className={styles.source}
            data-analyze-section="source"
            data-analyze-source
        >
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>Artifact source</p>
                    <h2 id="analyze-source-title">Import offline or load from Control</h2>
                    <p>Artifact bytes stay in memory and are never written to the URL or browser storage.</p>
                </div>
                <span data-artifact-status={controller.status}>
                    {statusLabel(controller.status, controller.busyAction)}
                </span>
            </header>

            <div className={styles.sourceGrid}>
                <div
                    className={styles.dropzone}
                    data-analyze-dropzone
                    data-drag-active={dragActive || undefined}
                    onDragEnter={event => {
                        event.preventDefault();
                        setDragActive(true);
                    }}
                    onDragLeave={() => setDragActive(false)}
                    onDragOver={event => event.preventDefault()}
                    onDrop={dropFiles}
                    aria-disabled={Boolean(controller.busyAction)}
                    role="group"
                    aria-label="Offline artifact import"
                >
                    <div className={styles.dropCopy}>
                        <strong>Drop a distributed artifact bundle</strong>
                        <span>JSON/JSONL files or one exported artifact envelope</span>
                    </div>
                    <div className={styles.pickerActions}>
                        <button
                            disabled={Boolean(controller.busyAction)}
                            onClick={() => filesInputRef.current?.click()}
                            type="button"
                        >
                            Choose files
                        </button>
                        <button
                            disabled={Boolean(controller.busyAction)}
                            onClick={() => folderInputRef.current?.click()}
                            type="button"
                        >
                            Choose folder
                        </button>
                    </div>
                    <input
                        accept=".json,.jsonl,application/json,application/x-ndjson"
                        className={styles.fileInput}
                        data-analyze-file-input
                        disabled={Boolean(controller.busyAction)}
                        multiple
                        onChange={selectFiles}
                        ref={filesInputRef}
                        type="file"
                    />
                    <input
                        {...DIRECTORY_INPUT_ATTRIBUTES}
                        className={styles.fileInput}
                        data-analyze-directory-input
                        disabled={Boolean(controller.busyAction)}
                        multiple
                        onChange={selectFiles}
                        ref={folderInputRef}
                        type="file"
                    />
                </div>

                <div className={styles.controlSource} data-analyze-control-source>
                    <div className={styles.selectionFields}>
                        <label>
                            <span>Control run</span>
                            <select
                                aria-label="Analyze control run"
                                data-analyze-control-run
                                onChange={event => controller.selectControlRun(event.target.value)}
                                value={controller.controlRunId ?? ''}
                            >
                                <option value="">Select control run</option>
                                {missingControlOption ? (
                                    <option value={controller.controlRunId}>
                                        {controller.controlRunId} · artifact only
                                    </option>
                                ) : null}
                                {controller.controlRunOptions.map(run => (
                                    <option key={run.runId} value={run.runId}>
                                        {run.runId}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            <span>Distributed run</span>
                            <select
                                aria-label="Analyze distributed run"
                                data-analyze-distributed-run
                                disabled={!controller.controlRunId}
                                onChange={event => controller.selectDistributedRun(event.target.value)}
                                value={controller.distributedRunId ?? ''}
                            >
                                <option value="">Select distributed run</option>
                                {missingDistributedOption ? (
                                    <option value={controller.distributedRunId}>
                                        {controller.distributedRunId} · artifact only
                                    </option>
                                ) : null}
                                {controller.distributedRunOptions.map(run => (
                                    <option key={run.distributedRunId} value={run.distributedRunId}>
                                        {run.manifest.displayName ?? run.distributedRunId} · {run.state}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                    <div className={styles.controlActions}>
                        <button
                            data-analyze-load-artifact
                            disabled={!controller.canLoad}
                            onClick={() => void loadControlArtifact()}
                            title={!controller.canLoad ? controller.loadReason : undefined}
                            type="button"
                        >
                            {loading ? 'Loading artifact…' : 'Load artifact'}
                        </button>
                        <button
                            data-analyze-export-artifact
                            disabled={!controller.model}
                            onClick={controller.exportArtifact}
                            type="button"
                        >
                            Export artifact
                        </button>
                        <button
                            data-analyze-clear-artifact
                            disabled={!controller.model && !controller.busyAction}
                            onClick={() => {
                                controller.clearArtifact();
                                setAnnouncement('Artifact cleared from browser memory.');
                            }}
                            type="button"
                        >
                            Clear
                        </button>
                    </div>
                    {!controller.canLoad && controller.loadReason ? (
                        <p className={styles.loadReason}>{controller.loadReason}</p>
                    ) : null}
                </div>
            </div>

            {controller.model ? (
                <p className={styles.provenance} data-analyze-provenance>
                    <strong>{controller.model.provenance.label}</strong>
                    <span>
                        {controller.model.provenance.artifactFileCount} artifact files ·
                        {' '}{controller.model.workspace.support} · schema v
                        {controller.model.workspace.artifactSchemaVersion ?? 'unknown'}
                    </span>
                </p>
            ) : null}
            <nav aria-label="Legacy artifact workflows" className={styles.legacyLinks}>
                <a href={legacyRunsHref}>Open selected run in legacy Runs</a>
                <a href={legacySharedTestHref}>Open generic export in legacy Shared Test</a>
            </nav>
            {controller.error ? (
                <p className={styles.error} data-analyze-operation-error role="alert">
                    {controller.model ? 'Previous analysis retained. ' : ''}
                    {controller.error}
                </p>
            ) : null}
            <p className={styles.announcement} role="status" aria-live="polite">
                {importing
                    ? isBusyRejection(announcement)
                        ? announcement
                        : 'Reading selected artifact files…'
                    : loading
                    ? isBusyRejection(announcement)
                        ? announcement
                        : 'Control artifact load started. Waiting for bounded evidence.'
                    : controller.status === 'ready' &&
                        controller.model?.provenance.source === 'control'
                    ? `Control artifact ready: ${controller.model.distributedRunId}.`
                    : announcement}
            </p>
        </section>
    );
}

function busyActionLabel(
    action: NonNullable<AnalyzeWorkspaceController['busyAction']>,
): string {
    return action === 'load-control'
        ? 'Control artifact loading'
        : 'artifact import';
}

function isBusyRejection(message: string): boolean {
    return message.startsWith('Artifact selection rejected while');
}

function statusLabel(
    status: AnalyzeWorkspaceController['status'],
    busyAction: AnalyzeWorkspaceController['busyAction'],
): string {
    if (busyAction === 'import-local') return 'Importing';
    if (busyAction === 'load-control') return 'Loading';
    if (status === 'ready') return 'Artifact ready';
    if (status === 'error') return 'Needs attention';
    return 'No artifact loaded';
}
