import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import { Metric } from '../../shared/Metric.tsx';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { formatTime } from '../../shared/time-format.ts';
import type { RallarBrowserStatusSummary } from '../../shell/rallar-browser-status.ts';
import { CommandCenterActionFeedbackPanel } from '../shared/CommandCenterActionFeedbackPanel.tsx';
import type { WebSocketCommandCenterValues } from './websocket-contracts.ts';
import { WEBSOCKET_PAYLOAD_PRESETS } from './websocket-presets.ts';
import { defaultWebSocketApiUrl } from './websocket-routing.ts';
import type { WebSocketCommandCenterViewModel } from './websocket-view-contracts.ts';

export function WebSocketCommandCenterView({
    state,
    authSession,
    browserStatus,
    busy,
    model
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
    browserStatus: RallarBrowserStatusSummary;
    busy: boolean;
    model: WebSocketCommandCenterViewModel;
}) {
    const {
        providerMode,
        values,
        payloadPresetId,
        localError,
        busyAction,
        actionFeedback,
        waitStatus,
        ticket,
        subscription,
        diagnostics,
        activePreset,
        canSendViaRallarSignaling,
        routePreview,
        subscriptionStatusLabel,
        subscriptionStatusTone,
        receiveStatusText,
        payloadResult,
        updateValue,
        updateGroupId,
        updateWsScope,
        selectPayloadPreset,
        configure,
        open,
        send,
        close,
        reconnect,
        cleanup,
        subscribeWs,
        unsubscribeWs,
        createTicket,
        waitForMessage,
        waitForRallarWsOpen,
        copyDiagnostics,
        copyRecipe,
        openMissingTicket
    } = model;

    return (
        <section className="panel websocket-command-center-panel">
            <div className="panel-heading">
                <h2>WebSocket Command Center</h2>
                <span
                    className={`pill ${
                        diagnostics.status === 'error' ? 'bad' : diagnostics.status === 'open' ? 'good' : 'muted'
                    }`}
                >
                    {diagnostics.statusLabel}
                </span>
            </div>
            <CollapsiblePanelSection
                title="WebSocket Inputs"
                meta={routePreview.destination}
            >
                <div className="websocket-context-grid">
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={values.apiBaseUrl}
                            onChange={(event) => updateValue('apiBaseUrl', event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Connection</span>
                        <input
                            value={values.connection}
                            onChange={(event) => updateValue('connection', event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Application</span>
                        <input
                            value={values.applicationId}
                            onChange={(event) => updateValue('applicationId', event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Workspace</span>
                        <input
                            value={values.workspaceId}
                            onChange={(event) => updateValue('workspaceId', event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Group</span>
                        <input
                            value={values.groupId}
                            onChange={(event) => updateGroupId(event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>WS Scope</span>
                        <select
                            value={values.wsScope}
                            onChange={(event) =>
                                updateWsScope(
                                    event.target
                                        .value as WebSocketCommandCenterValues['wsScope']
                                )}
                        >
                            <option value="room">room</option>
                            <option value="all">all</option>
                            <option value="world">world</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Type ID</span>
                        <input
                            value={values.typeId}
                            onChange={(event) => updateValue('typeId', event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Topic ID</span>
                        <input
                            value={values.topicId}
                            onChange={(event) => updateValue('topicId', event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Context ID</span>
                        <input
                            value={values.contextId}
                            onChange={(event) => updateValue('contextId', event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Resource ID</span>
                        <input
                            value={values.resourceId}
                            onChange={(event) => updateValue('resourceId', event.target.value)}
                        />
                    </label>
                    <label className="field websocket-url-field">
                        <span>WebSocket URL</span>
                        <input
                            value={values.wsUrl}
                            onChange={(event) => updateValue('wsUrl', event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Protocols</span>
                        <input
                            value={values.protocols}
                            onChange={(event) => updateValue('protocols', event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Timeout</span>
                        <input
                            type="number"
                            min={0}
                            value={values.timeoutMs}
                            onChange={(event) =>
                                updateValue(
                                    'timeoutMs',
                                    Number(event.target.value)
                                )}
                        />
                    </label>
                    <label className="field">
                        <span>Close Code</span>
                        <input
                            type="number"
                            value={values.closeCode}
                            onChange={(event) =>
                                updateValue(
                                    'closeCode',
                                    Number(event.target.value)
                                )}
                        />
                    </label>
                    <label className="field">
                        <span>Close Reason</span>
                        <input
                            value={values.closeReason}
                            onChange={(event) => updateValue('closeReason', event.target.value)}
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <CommandCenterActionFeedbackPanel
                feedback={actionFeedback}
                state={state}
                authSession={authSession}
            />
            <div
                className="command-center-live-grid"
                aria-label="WebSocket live subscription status"
            >
                <Metric
                    label="WS subscribed"
                    value={subscription ? 'yes' : 'no'}
                    tone={subscription ? 'good' : 'warn'}
                />
                <Metric
                    label="Subscribed group"
                    value={subscription?.groupId || '-'}
                />
                <Metric
                    label="Subscribed selector"
                    value={subscription?.label ?? '-'}
                />
                <Metric
                    label="Subscribed since"
                    value={formatTime(subscription?.subscribedAtEpochMs)}
                />
                <Metric
                    label="Signal WS"
                    value={browserStatus.signalingLabel}
                    tone={browserStatus.signalingTone}
                />
                <Metric
                    label="Raw WS"
                    value={diagnostics.statusLabel}
                    tone={diagnostics.status === 'open'
                        ? 'good'
                        : diagnostics.status === 'error'
                        ? 'bad'
                        : 'muted'}
                />
            </div>
            <div className="websocket-action-section">
                <div className="section-heading">
                    <h3>Rallar WS Messages</h3>
                    <span>rallar.messages.ws</span>
                </div>
                <div className="websocket-action-grid">
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void send()}
                    >
                        {routePreview.sendLabel}
                    </button>
                    <button
                        type="button"
                        disabled={busy ||
                            Boolean(busyAction) ||
                            providerMode !== 'browser-rallar' ||
                            !authSession}
                        onClick={() => void subscribeWs()}
                    >
                        Subscribe WS
                    </button>
                    <button
                        type="button"
                        disabled={!subscription}
                        onClick={unsubscribeWs}
                    >
                        Unsubscribe WS
                    </button>
                    <button
                        type="button"
                        disabled={busy ||
                            Boolean(busyAction) ||
                            providerMode !== 'browser-rallar' ||
                            !authSession}
                        onClick={() => void waitForRallarWsOpen()}
                    >
                        Wait Rallar WS open
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void waitForMessage()}
                    >
                        Wait for message
                    </button>
                    <button type="button" onClick={() => copyRecipe(false)}>
                        Copy WS recipe
                    </button>
                    <button type="button" onClick={() => copyRecipe(true)}>
                        Copy WS/RTC compare recipe
                    </button>
                </div>
            </div>
            <div className="websocket-action-section">
                <div className="section-heading">
                    <h3>Raw WebSocket Diagnostics</h3>
                    <span>ticket/socket checks</span>
                </div>
                <div className="websocket-action-grid">
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void configure()}
                    >
                        Configure WS
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction) || !authSession}
                        onClick={() => void createTicket()}
                    >
                        Create WS ticket
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void open()}
                    >
                        Open
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void open(defaultWebSocketApiUrl(values.apiBaseUrl))}
                    >
                        Open API WS
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void reconnect()}
                    >
                        Reconnect
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void close()}
                    >
                        Close
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void cleanup()}
                    >
                        Cleanup
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void openMissingTicket()}
                    >
                        Missing ticket open
                    </button>
                    <button type="button" onClick={copyDiagnostics}>
                        Copy diagnostics
                    </button>
                </div>
            </div>
            <CollapsiblePanelSection
                title="WebSocket Payload"
                meta={activePreset.label}
            >
                <div className="websocket-payload-grid">
                    <label className="field">
                        <span>Payload Preset</span>
                        <select
                            value={payloadPresetId}
                            onChange={(event) => selectPayloadPreset(event.target.value)}
                        >
                            {WEBSOCKET_PAYLOAD_PRESETS.map((preset) => (
                                <option
                                    key={preset.presetId}
                                    value={preset.presetId}
                                >
                                    {preset.label}
                                </option>
                            ))}
                        </select>
                        <small>{activePreset.description}</small>
                    </label>
                    <label className="json-editor">
                        <span>Payload JSON</span>
                        <textarea
                            value={values.payloadText}
                            onChange={(event) => updateValue('payloadText', event.target.value)}
                            spellCheck={false}
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div
                className="websocket-route-preview"
                aria-label="WebSocket route preview"
            >
                <div>
                    <span>Destination</span>
                    <strong>{routePreview.destination}</strong>
                    <small>{routePreview.destinationDetail}</small>
                </div>
                <div>
                    <span>Selector</span>
                    <strong>{routePreview.selector}</strong>
                    <small>{routePreview.selectorDetail}</small>
                </div>
                <div>
                    <span>Transport</span>
                    <strong>{routePreview.transport}</strong>
                    <small>{routePreview.transportDetail}</small>
                </div>
            </div>
            <div
                className="websocket-received-panel"
                aria-label="Received WebSocket messages"
            >
                <div className="websocket-received-heading">
                    <div>
                        <h3>Received WS Messages</h3>
                        <p>{receiveStatusText}</p>
                    </div>
                    <span className={`pill ${subscriptionStatusTone}`}>
                        {subscriptionStatusLabel}
                    </span>
                </div>
                <div className="websocket-received-summary">
                    <Metric
                        label="Listening group"
                        value={subscription?.groupId || '-'}
                    />
                    <Metric
                        label="Listening selector"
                        value={subscription?.label ?? '-'}
                    />
                    <Metric
                        label="Received"
                        value={String(diagnostics.receivedMessages.length)}
                    />
                    <Metric
                        label="Listening since"
                        value={formatTime(subscription?.subscribedAtEpochMs)}
                    />
                    <Metric
                        label="Last received"
                        value={formatTime(
                            diagnostics.receivedMessages.at(-1)?.atEpochMs
                        )}
                    />
                </div>
                <div className="websocket-received-list">
                    {diagnostics.receivedMessages.length === 0 && (
                        <div className="empty-state">
                            No received WebSocket messages
                        </div>
                    )}
                    {diagnostics.receivedMessages
                        .slice()
                        .reverse()
                        .map((message) => (
                            <article
                                className="websocket-received-row"
                                key={message.eventId}
                            >
                                <div>
                                    <strong>
                                        {message.topicId} / {message.typeId}
                                    </strong>
                                    <small>
                                        {formatTime(message.atEpochMs)} - group {message.roomId} - sender{' '}
                                        {message.senderId}
                                    </small>
                                    <small>
                                        context {message.contextId} - resource {message.resourceId}
                                    </small>
                                </div>
                                <pre className="mini-json">
                                    {redactedJson(
                                        message.payload,
                                        state,
                                        authSession,
                                    )}
                                </pre>
                            </article>
                        ))}
                </div>
            </div>
            <div className="websocket-status-grid">
                <Metric label="Provider" value={providerMode} />
                <Metric
                    label="Raw WS"
                    value={diagnostics.statusLabel}
                    tone={diagnostics.status === 'open'
                        ? 'good'
                        : diagnostics.status === 'error'
                        ? 'bad'
                        : 'muted'}
                />
                <Metric
                    label="Signal WS"
                    value={browserStatus.signalingLabel}
                    tone={browserStatus.signalingTone}
                />
                <Metric
                    label="Rallar WS send"
                    value={canSendViaRallarSignaling ||
                            diagnostics.status === 'open'
                        ? 'available'
                        : '-'}
                    tone={canSendViaRallarSignaling ||
                            diagnostics.status === 'open'
                        ? 'good'
                        : 'muted'}
                />
                <Metric
                    label="Raw ready state"
                    value={diagnostics.readyState}
                />
                <Metric
                    label="Inbound"
                    value={String(diagnostics.inboundCount)}
                />
                <Metric
                    label="Outbound"
                    value={String(diagnostics.outboundCount)}
                />
                <Metric
                    label="Errors"
                    value={String(diagnostics.errorCount)}
                    tone={diagnostics.errorCount > 0 ? 'bad' : 'good'}
                />
                <Metric label="Wait" value={waitStatus} />
                <Metric label="Group" value={values.groupId || '-'} />
                <Metric
                    label="Selector"
                    value={`${values.topicId || '*'} / ${values.typeId || '-'}`}
                />
                <Metric
                    label="Subscription"
                    value={subscription?.label ?? '-'}
                />
                <Metric label="Ticket" value={ticket ? 'redacted' : '-'} />
                <Metric
                    label="Ticket expires"
                    value={formatTime(ticket?.expiresAtEpochMs)}
                />
                <Metric
                    label="Last open"
                    value={formatTime(diagnostics.lastOpenAtEpochMs)}
                />
                <Metric
                    label="Last close"
                    value={formatTime(diagnostics.lastCloseAtEpochMs)}
                />
                <Metric
                    label="Close code"
                    value={String(diagnostics.closeCode ?? '-')}
                />
                <Metric
                    label="Close reason"
                    value={String(diagnostics.closeReason ?? '-')}
                />
            </div>
            {(localError || !payloadResult.ok) && (
                <div
                    className={localError || !payloadResult.ok
                        ? 'workbench-error'
                        : 'command-center-status'}
                    role="status"
                >
                    {localError ??
                        (!payloadResult.ok ? payloadResult.error : undefined)}
                </div>
            )}
            {canSendViaRallarSignaling && !localError && (
                <div className="command-center-status" role="status">
                    Send JSON uses rallar.messages.ws.send and connects Rallar signaling if needed. Open is only for raw
                    WebSocket checks.
                </div>
            )}
            <div className="websocket-event-log-heading">
                <h3>WebSocket Event Log</h3>
                <span>{diagnostics.recentEvents.length} recent</span>
            </div>
            <div className="websocket-event-list">
                {diagnostics.recentEvents.length === 0 && <div className="empty-state">No WebSocket events yet</div>}
                {diagnostics.recentEvents
                    .slice()
                    .reverse()
                    .map((event) => (
                        <article
                            className="websocket-event-row"
                            key={event.eventId}
                        >
                            <div>
                                <strong>{event.topic}</strong>
                                <small>
                                    {formatTime(event.atEpochMs)} - {event.kind}
                                </small>
                            </div>
                            <span
                                className={`pill ${
                                    event.severity === 'error' ? 'bad' : event.kind === 'message' ? 'good' : 'muted'
                                }`}
                            >
                                {event.severity}
                            </span>
                            <pre className="mini-json">
                                {redactedJson(
                                    event.payload,
                                    state,
                                    authSession,
                                )}
                            </pre>
                        </article>
                    ))}
            </div>
        </section>
    );
}
