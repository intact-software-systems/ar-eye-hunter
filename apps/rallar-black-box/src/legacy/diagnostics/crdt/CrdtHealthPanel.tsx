import { Metric } from '../../shared/Metric.tsx';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { formatTime } from '../../shared/time-format.ts';
import { CrdtEditorPanel } from './CrdtEditorView.tsx';
import type { CrdtPanelInput } from './crdt-contracts.ts';
import {
    useCrdtHealthController,
    type CrdtHealthControllerModel,
} from './use-crdt-health-controller.ts';

export function CrdtHealthPanel(props: CrdtPanelInput) {
    const { state, bootstrap, authSession, globalValues } = props;
    const model: CrdtHealthControllerModel = useCrdtHealthController(props);
    const {
        busyAction,
        error,
        documents,
        setSelectedDocumentKey,
        lastResult,
        selectedDocument,
        providerReady,
        canCallAdmin,
        copyAdminRecipe,
        refresh,
        runDocumentAction,
    } = model;
    return (
        <section className="panel crdt-health-panel">
            <div className="section-heading">
                <h2>CRDT</h2>
                <span>{documents.length} documents</span>
            </div>
            <div className="metric-row">
                <Metric
                    label="Provider"
                    value={bootstrap.providerMode}
                    tone={providerReady ? 'good' : 'warn'}
                />
                <Metric label="API" value={globalValues.apiBaseUrl} />
                <Metric
                    label="Auth"
                    value={authSession ? 'session' : 'missing'}
                    tone={authSession ? 'good' : 'warn'}
                />
                <Metric
                    label="Workspace"
                    value={globalValues.workspaceId || '-'}
                />
            </div>
            <CrdtEditorPanel
                state={state}
                bootstrap={bootstrap}
                authSession={authSession}
                globalValues={globalValues}
            />
            <div className="section-heading">
                <h3>Admin Health</h3>
                <span>durable documents</span>
            </div>
            <div className="button-row">
                <button
                    type="button"
                    disabled={!canCallAdmin}
                    onClick={() => void refresh()}
                >
                    Refresh
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('integrity')}
                >
                    Integrity
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('debug-export')}
                >
                    Debug Export
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('backup-export')}
                >
                    Backup Export
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('compact')}
                >
                    Compact
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('rebuild')}
                >
                    Rebuild
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('archive')}
                >
                    Archive
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('quarantine')}
                >
                    Quarantine
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('destroy')}
                >
                    Destroy
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('integrity')}
                >
                    Copy Integrity Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('debug-export')}
                >
                    Copy Debug Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('backup-export')}
                >
                    Copy Backup Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('compact')}
                >
                    Copy Compact Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('rebuild')}
                >
                    Copy Rebuild Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('archive')}
                >
                    Copy Archive Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('quarantine')}
                >
                    Copy Quarantine Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('destroy')}
                >
                    Copy Destroy Recipe
                </button>
            </div>
            {busyAction && (
                <div className="status-line">
                    CRDT admin action: {busyAction}
                </div>
            )}
            {!providerReady && (
                <div className="workbench-error" role="status">
                    CRDT admin health requires provider=browser-rallar.
                </div>
            )}
            {providerReady && !authSession && (
                <div className="workbench-error" role="status">
                    Login is required before calling CRDT admin routes.
                </div>
            )}
            {error && (
                <div className="workbench-error" role="status">
                    {error}
                </div>
            )}
            <div className="table-shell">
                <table>
                    <thead>
                        <tr>
                            <th>Document</th>
                            <th>Lifecycle</th>
                            <th>Updates</th>
                            <th>Snapshots</th>
                            <th>Append</th>
                            <th>Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        {documents.map((document) => (
                            <tr
                                key={document.documentKey}
                                className={
                                    document.documentKey ===
                                    selectedDocument?.documentKey
                                        ? 'selected'
                                        : ''
                                }
                                onClick={() =>
                                    setSelectedDocumentKey(document.documentKey)
                                }
                            >
                                <td>{document.documentKey}</td>
                                <td>{document.lifecycle}</td>
                                <td>{document.updateCount}</td>
                                <td>{document.snapshotCount}</td>
                                <td>{document.lastAppendSequence}</td>
                                <td>{formatTime(document.updatedAtEpochMs)}</td>
                            </tr>
                        ))}
                        {documents.length === 0 && (
                            <tr>
                                <td colSpan={6}>No CRDT documents returned.</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
            <section>
                <div className="section-heading">
                    <h3>Selected / Last Result</h3>
                    <span>{selectedDocument?.lifecycle ?? 'none'}</span>
                </div>
                {selectedDocument && (
                    <div className="metric-row">
                        <Metric
                            label="Lifecycle"
                            value={selectedDocument.lifecycle}
                            tone={
                                selectedDocument.lifecycle === 'active'
                                    ? 'good'
                                    : selectedDocument.lifecycle === 'quarantined'
                                      ? 'bad'
                                      : 'warn'
                            }
                        />
                        <Metric
                            label="Rollout"
                            value={selectedDocument.rollout ?? '-'}
                        />
                        <Metric
                            label="Append"
                            value={String(selectedDocument.lastAppendSequence)}
                        />
                        <Metric
                            label="Quarantine"
                            value={selectedDocument.quarantineReason ?? '-'}
                            tone={
                                selectedDocument.quarantineReason
                                    ? 'bad'
                                    : 'muted'
                            }
                        />
                    </div>
                )}
                <pre className="mini-json">
                    {redactedJson(
                        lastResult ?? selectedDocument ?? {},
                        state,
                        authSession,
                    )}
                </pre>
            </section>
        </section>
    );
}
