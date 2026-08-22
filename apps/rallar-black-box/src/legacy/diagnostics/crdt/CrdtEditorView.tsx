import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { CRDT_EDITOR_TRANSPORTS, crdtEditorOperationGroupId, type CrdtEditorTransport } from '../../../crdt-editor.ts';
import { Metric } from '../../shared/Metric.tsx';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import type { CrdtPanelInput } from './crdt-contracts.ts';
import { CrdtEditorBoardView } from './CrdtEditorBoardView.tsx';
import { CrdtEditorEntitiesView } from './CrdtEditorEntitiesView.tsx';
import { useCrdtEditorController, type CrdtEditorControllerModel } from './use-crdt-editor-controller.ts';

export function CrdtEditorView({
    state,
    authSession,
    model
}: Readonly<{
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
    model: CrdtEditorControllerModel;
}>) {
    const {
        documentName,
        setDocumentName,
        documentId,
        setDocumentId,
        transport,
        setTransport,
        persist,
        setPersist,
        tabSync,
        setTabSync,
        view,
        setView,
        busyAction,
        error,
        opened,
        value,
        health,
        lastResult,
        lastBatch,
        lastOperationGroupId,
        providerReady,
        canUseLiveTransport,
        canRun,
        columns,
        runEditorAction,
        closeDocument,
        destroyDocument
    } = model;
    return (
        <section className="crdt-editor-panel">
            <div className="section-heading">
                <h3>CRDT Editor</h3>
                <span>{opened ? 'open' : 'closed'}</span>
            </div>
            <div className="metric-row">
                <Metric label="Transport" value={transport} />
                <Metric label="Document" value={documentId} />
                <Metric
                    label="Runtime"
                    value={providerReady ? 'browser-rallar' : 'local import'}
                    tone={providerReady ? 'good' : 'warn'}
                />
                <Metric
                    label="Live Auth"
                    value={canUseLiveTransport ? 'ready' : 'local-only'}
                    tone={transport === 'local-only' || canUseLiveTransport
                        ? 'good'
                        : 'warn'}
                />
            </div>
            <div className="form-grid crdt-editor-controls">
                <label>
                    Document name
                    <input
                        value={documentName}
                        onChange={(event) => setDocumentName(event.target.value)}
                        disabled={opened}
                    />
                </label>
                <label>
                    Document id
                    <input
                        value={documentId}
                        onChange={(event) => setDocumentId(event.target.value)}
                        disabled={opened}
                    />
                </label>
                <label>
                    Transport
                    <select
                        value={transport}
                        onChange={(event) =>
                            setTransport(
                                event.target.value as CrdtEditorTransport
                            )}
                        disabled={opened}
                    >
                        {CRDT_EDITOR_TRANSPORTS.map((option) => (
                            <option key={option} value={option}>
                                {option}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={persist}
                        onChange={(event) => setPersist(event.target.checked)}
                        disabled={opened}
                    />
                    Persist locally
                </label>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={tabSync}
                        onChange={(event) => setTabSync(event.target.checked)}
                        disabled={opened}
                    />
                    Tab sync
                </label>
            </div>
            <div className="button-row">
                <button
                    type="button"
                    disabled={!canRun || opened}
                    onClick={() =>
                        void runEditorAction('open', async (document) => ({
                            action: 'open',
                            document: document.ref,
                            value: document.read(),
                            health: document.health()
                        }))}
                >
                    Open
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('sync', async (document) => ({
                            action: 'sync',
                            result: await document.sync({
                                reason: 'black-box-crdt-editor',
                                transport
                            })
                        }))}
                >
                    Sync
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('read', async (document) => ({
                            action: 'read',
                            value: document.read(),
                            health: document.health()
                        }))}
                >
                    Read
                </button>
                <button
                    type="button"
                    disabled={!opened || !lastBatch || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('undo', async (document) => ({
                            action: 'undo',
                            update: await document.undoOperationGroup({
                                targetOperationGroupId: lastOperationGroupId ?? '',
                                operations: lastBatch?.operations ?? [],
                                operationGroupId: crdtEditorOperationGroupId('undo')
                            })
                        }))}
                >
                    Undo
                </button>
                <button
                    type="button"
                    disabled={!opened || !lastBatch || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('redo', async (document) => ({
                            action: 'redo',
                            update: await document.redoOperationGroup({
                                targetOperationGroupId: lastOperationGroupId ?? '',
                                operations: lastBatch?.operations ?? [],
                                operationGroupId: crdtEditorOperationGroupId('redo')
                            })
                        }))}
                >
                    Redo
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() => void closeDocument()}
                >
                    Close
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() => void destroyDocument()}
                >
                    Destroy
                </button>
            </div>
            {busyAction && <div className="status-line">CRDT editor action: {busyAction}</div>}
            {transport !== 'local-only' && !canUseLiveTransport && (
                <div className="workbench-error" role="status">
                    Live CRDT transports require provider=browser-rallar and a login session. Switch to local-only for
                    offline sandboxing.
                </div>
            )}
            {error && (
                <div className="workbench-error" role="status">
                    {error}
                </div>
            )}
            <div className="button-row segmented-row">
                <button
                    type="button"
                    className={view === 'board' ? 'selected' : ''}
                    onClick={() => setView('board')}
                >
                    Board
                </button>
                <button
                    type="button"
                    className={view === 'entities' ? 'selected' : ''}
                    onClick={() => setView('entities')}
                >
                    Entities
                </button>
            </div>
            {view === 'board' ? <CrdtEditorBoardView model={model} /> : <CrdtEditorEntitiesView model={model} />}
            <div className="crdt-editor-diagnostics">
                <section>
                    <div className="section-heading">
                        <h4>Value</h4>
                        <span>{columns.length} columns</span>
                    </div>
                    <pre className="mini-json">
                        {redactedJson(value, state, authSession)}
                    </pre>
                </section>
                <section>
                    <div className="section-heading">
                        <h4>Last Result / Health</h4>
                        <span>{lastOperationGroupId ?? 'no group'}</span>
                    </div>
                    <pre className="mini-json">
                        {redactedJson(
                            { lastResult, health, lastBatch },
                            state,
                            authSession,
                        )}
                    </pre>
                </section>
            </div>
        </section>
    );
}

export function CrdtEditorPanel(props: CrdtPanelInput) {
    const model = useCrdtEditorController(props);
    return (
        <CrdtEditorView
            state={props.state}
            authSession={props.authSession}
            model={model}
        />
    );
}
