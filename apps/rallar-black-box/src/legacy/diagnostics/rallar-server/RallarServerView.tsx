import type { AuthSession } from '@shared/api/api-config.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import {
    redactRallarServerUrl,
    redactRallarServerValue,
    type RallarServerResponseBodyMode,
    type RallarServerRestMethod,
} from '../../../rallar-server-workbench.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import {
    redactedJson,
    uiRedactionOptions,
} from '../../shared/redaction-presentation.ts';
import { formatDuration } from '../../shared/time-format.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { RallarServerRequestFeedbackPanel } from './RallarServerRequestFeedbackPanel.tsx';
import type { RallarServerControllerModel } from './use-rallar-server-controller.ts';

export function RallarServerView({
    state,
    authSession,
    control,
    onGlobalValueChange,
    model,
}: Readonly<{
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
    control: RallarBlackBoxControlSnapshot;
    onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
    model: RallarServerControllerModel;
}>) {
    const {
        providerMode,
        apiBaseUrl,
        config,
        serverOpenApiPresets,
        method,
        path,
        selectedPresetId,
        allPresets,
        applyPreset,
        setServerDraftEdited,
        setApiBaseUrl,
        setMethod,
        timeoutMs,
        setTimeoutMs,
        setPath,
        responseBodyMode,
        setResponseBodyMode,
        attachAuth,
        setAttachAuth,
        queryText,
        setQueryText,
        headersText,
        setHeadersText,
        bodyText,
        setBodyText,
        sendRequest,
        busy,
        activePreset,
        refreshOpenApi,
        openApiBusy,
        copyCurl,
        copyCommand,
        latestGroupId,
        latestClientId,
        latestSessionId,
        requestFeedback,
        localError,
        collectionResults,
        selectedCollectionId,
        applyCollectionTemplate,
        collectionTemplates,
        addCurrentRequestToCollection,
        runCollection,
        collectionBusy,
        copyCollection,
        copyCollectionRecipe,
        collectionVariablesText,
        setCollectionVariablesText,
        collectionText,
        setCollectionText,
        collectionError,
        response,
        responseBodyText,
        responseHeadersText,
        commandPreview,
    } = model;
    return (
        <section className="panel rallar-server-panel">
            <div className="panel-heading">
                <h2>Rallar Server</h2>
                <span
                    className={`pill ${authSession ? 'good' : providerMode === 'browser-rallar' ? 'bad' : 'muted'}`}
                >
                    {authSession ? 'authenticated' : 'no session'}
                </span>
            </div>
            <dl className="config-list rest-context-list">
                <div>
                    <dt>API base</dt>
                    <dd>{apiBaseUrl}</dd>
                </div>
                <div>
                    <dt>Provider</dt>
                    <dd>{providerMode}</dd>
                </div>
                <div>
                    <dt>User</dt>
                    <dd>{authSession?.username ?? config?.actor ?? 'none'}</dd>
                </div>
                <div>
                    <dt>Client</dt>
                    <dd>{authSession?.clientId ?? config?.actor ?? 'none'}</dd>
                </div>
                <div>
                    <dt>Session</dt>
                    <dd>
                        {authSession?.sessionId ?? config?.sessionId ?? 'none'}
                    </dd>
                </div>
                <div>
                    <dt>Access token</dt>
                    <dd>{authSession?.accessToken ? 'redacted' : 'none'}</dd>
                </div>
                <div>
                    <dt>Control</dt>
                    <dd>{control.state}</dd>
                </div>
                <div>
                    <dt>Preset source</dt>
                    <dd>
                        {serverOpenApiPresets.length > 0
                            ? 'server OpenAPI'
                            : 'local OpenAPI'}
                    </dd>
                </div>
            </dl>
            <CollapsiblePanelSection
                title="REST Request Inputs"
                meta={`${method} ${path}`}
            >
                <div className="rest-workbench-grid">
                    <label className="field">
                        <span>Endpoint</span>
                        <select
                            value={selectedPresetId}
                            onChange={(event) => {
                                const nextPreset = allPresets.find(
                                    (preset) =>
                                        preset.presetId === event.target.value,
                                );
                                if (nextPreset) {
                                    applyPreset(nextPreset);
                                }
                            }}
                        >
                            {allPresets.map((preset) => (
                                <option
                                    key={preset.presetId}
                                    value={preset.presetId}
                                >
                                    {preset.tag} - {preset.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={apiBaseUrl}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setApiBaseUrl(event.target.value);
                            }}
                        />
                    </label>
                    <label className="field compact-field">
                        <span>Method</span>
                        <select
                            value={method}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setMethod(
                                    event.target
                                        .value as RallarServerRestMethod,
                                );
                            }}
                        >
                            {(['GET', 'POST', 'PUT', 'DELETE'] as const).map(
                                (entry) => (
                                    <option key={entry} value={entry}>
                                        {entry}
                                    </option>
                                ),
                            )}
                        </select>
                    </label>
                    <label className="field compact-field">
                        <span>Timeout</span>
                        <input
                            type="number"
                            min={0}
                            value={timeoutMs}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setTimeoutMs(Number(event.target.value));
                            }}
                        />
                    </label>
                    <label className="field rest-path-field">
                        <span>Path</span>
                        <input
                            value={path}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setPath(event.target.value);
                            }}
                        />
                    </label>
                    <label className="field compact-field">
                        <span>Body Mode</span>
                        <select
                            value={responseBodyMode}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setResponseBodyMode(
                                    event.target
                                        .value as RallarServerResponseBodyMode,
                                );
                            }}
                        >
                            {(['auto', 'json', 'text', 'none'] as const).map(
                                (entry) => (
                                    <option key={entry} value={entry}>
                                        {entry}
                                    </option>
                                ),
                            )}
                        </select>
                    </label>
                    <label className="check-field rest-auth-check">
                        <input
                            type="checkbox"
                            checked={attachAuth}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setAttachAuth(event.target.checked);
                            }}
                        />
                        <span>Attach auth</span>
                    </label>
                </div>
                <div className="rest-editors">
                    <label className="json-editor">
                        <span>Query JSON</span>
                        <textarea
                            value={queryText}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setQueryText(event.target.value);
                            }}
                            spellCheck={false}
                        />
                    </label>
                    <label className="json-editor">
                        <span>Headers JSON</span>
                        <textarea
                            value={headersText}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setHeadersText(event.target.value);
                            }}
                            spellCheck={false}
                        />
                    </label>
                    <label className="json-editor">
                        <span>Body JSON</span>
                        <textarea
                            value={bodyText}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setBodyText(event.target.value);
                            }}
                            spellCheck={false}
                            disabled={method === 'GET'}
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div className="rest-actions">
                <button
                    type="button"
                    onClick={() => void sendRequest()}
                    disabled={busy}
                >
                    {busy ? 'Sending' : 'Send'}
                </button>
                <button
                    type="button"
                    onClick={() => applyPreset(activePreset)}
                    disabled={busy}
                >
                    Reset Preset
                </button>
                <button
                    type="button"
                    onClick={() => void refreshOpenApi()}
                    disabled={openApiBusy}
                >
                    {openApiBusy ? 'Loading OpenAPI' : 'Refresh OpenAPI'}
                </button>
                <button type="button" onClick={copyCurl}>
                    Copy cURL
                </button>
                <button type="button" onClick={copyCommand}>
                    Copy Command
                </button>
                <button
                    type="button"
                    disabled={!latestGroupId || !onGlobalValueChange}
                    onClick={() =>
                        latestGroupId &&
                        onGlobalValueChange?.('roomId', latestGroupId)
                    }
                >
                    Use group in Quick Test
                </button>
                <button
                    type="button"
                    disabled={!latestClientId || !onGlobalValueChange}
                    onClick={() =>
                        latestClientId &&
                        onGlobalValueChange?.('clientId', latestClientId)
                    }
                >
                    Use client globally
                </button>
                <button
                    type="button"
                    disabled={!latestSessionId || !onGlobalValueChange}
                    onClick={() =>
                        latestSessionId &&
                        onGlobalValueChange?.('sessionId', latestSessionId)
                    }
                >
                    Use session globally
                </button>
            </div>
            <RallarServerRequestFeedbackPanel
                feedback={requestFeedback}
                authSession={authSession}
            />
            {localError && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        localError,
                        uiRedactionOptions(state, authSession),
                    )}
                </div>
            )}
            <section className="rest-collection-panel">
                <div className="section-heading">
                    <h3>REST Collection</h3>
                    <span>{collectionResults.length} results</span>
                </div>
                <div className="rest-collection-toolbar">
                    <label className="field">
                        <span>Collection Template</span>
                        <select
                            value={selectedCollectionId}
                            onChange={(event) =>
                                applyCollectionTemplate(event.target.value)
                            }
                        >
                            {collectionTemplates.map((template) => (
                                <option
                                    key={template.collectionId}
                                    value={template.collectionId}
                                >
                                    {template.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        type="button"
                        onClick={addCurrentRequestToCollection}
                    >
                        Add Current Request
                    </button>
                    <button
                        type="button"
                        onClick={() => void runCollection()}
                        disabled={collectionBusy}
                    >
                        {collectionBusy
                            ? 'Running Collection'
                            : 'Run Collection'}
                    </button>
                    <button type="button" onClick={copyCollection}>
                        Copy Collection
                    </button>
                    <button type="button" onClick={copyCollectionRecipe}>
                        Copy Collection Recipe
                    </button>
                </div>
                <div className="rest-collection-editors">
                    <label className="json-editor">
                        <span>Variables JSON</span>
                        <textarea
                            value={collectionVariablesText}
                            onChange={(event) =>
                                setCollectionVariablesText(event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                    <label className="json-editor">
                        <span>Collection JSON</span>
                        <textarea
                            value={collectionText}
                            onChange={(event) =>
                                setCollectionText(event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                </div>
                {collectionError && (
                    <div className="workbench-error" role="status">
                        {redactRallarBlackBoxValue(
                            collectionError,
                            uiRedactionOptions(state, authSession),
                        )}
                    </div>
                )}
                <div className="rest-collection-results">
                    {collectionResults.length === 0 && (
                        <div className="empty-state">
                            No collection results yet
                        </div>
                    )}
                    {collectionResults.map((result) => (
                        <article
                            className="rest-collection-result-row"
                            key={result.stepId}
                        >
                            <div>
                                <strong>{result.label}</strong>
                                <small>
                                    {result.stepId} -{' '}
                                    {formatDuration(result.response.durationMs)}
                                </small>
                            </div>
                            <span
                                className={`pill ${result.ok ? 'good' : 'bad'}`}
                            >
                                {result.response.status ||
                                    result.response.error?.kind ||
                                    'failed'}
                            </span>
                            <div className="rest-assertion-list">
                                {result.assertions.map((assertion) => (
                                    <span
                                        className={`pill ${assertion.ok ? 'good' : 'bad'}`}
                                        key={assertion.label}
                                    >
                                        {assertion.label}
                                    </span>
                                ))}
                            </div>
                            {Object.keys(result.extracted).length > 0 && (
                                <pre className="mini-json">
                                    {redactedJson(
                                        result.extracted,
                                        state,
                                        authSession,
                                    )}
                                </pre>
                            )}
                        </article>
                    ))}
                </div>
            </section>
            <div className="rest-response-grid">
                <section className="rest-subpanel">
                    <div className="section-heading">
                        <h3>Response</h3>
                        <span
                            className={`pill ${response?.ok ? 'good' : response ? 'bad' : 'muted'}`}
                        >
                            {response
                                ? response.status > 0
                                    ? String(response.status)
                                    : (response.error?.kind ?? 'failed')
                                : 'idle'}
                        </span>
                    </div>
                    <dl className="result-summary">
                        <div>
                            <dt>Status</dt>
                            <dd>
                                {response
                                    ? `${response.status} ${response.statusText}`
                                    : '-'}
                            </dd>
                        </div>
                        <div>
                            <dt>Duration</dt>
                            <dd>{formatDuration(response?.durationMs)}</dd>
                        </div>
                        <div>
                            <dt>Body</dt>
                            <dd>{response?.bodyKind ?? '-'}</dd>
                        </div>
                        <div>
                            <dt>Error</dt>
                            <dd>{response?.error?.kind ?? 'none'}</dd>
                        </div>
                    </dl>
                    {response?.error && (
                        <div className="workbench-error" role="status">
                            {redactRallarServerValue(
                                response.error.message,
                                authSession,
                            )}
                        </div>
                    )}
                    <pre className="json-block">{responseBodyText}</pre>
                </section>
                <section className="rest-subpanel">
                    <div className="section-heading">
                        <h3>Headers</h3>
                        <span>
                            {response
                                ? redactRallarServerUrl(
                                      response.url,
                                      authSession,
                                  )
                                : '-'}
                        </span>
                    </div>
                    <pre className="json-block">{responseHeadersText}</pre>
                </section>
                <section className="rest-subpanel">
                    <div className="section-heading">
                        <h3>Command</h3>
                        <span>{method}</span>
                    </div>
                    <pre className="json-block">{commandPreview}</pre>
                </section>
            </div>
        </section>
    );
}
