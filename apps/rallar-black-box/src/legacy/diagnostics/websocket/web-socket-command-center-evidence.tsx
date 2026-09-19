import { Metric } from '../../shared/Metric.tsx';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { formatTime } from '../../shared/time-format.ts';
import type { WebSocketDiagnostic } from './websocket-contracts.ts';
import type { WebSocketCommandCenterViewProps } from './websocket-view-contracts.ts';

export function WebSocketCommandCenterEvidence(props: WebSocketCommandCenterViewProps) {
    const { model } = props;
    return (
        <>
            <WebSocketRoutePreviewPanel model={model} />
            <WebSocketReceivedMessagesPanel {...props} />
            <WebSocketStatusMetrics {...props} />
            <WebSocketCommandCenterNotices model={model} />
            <WebSocketEventLog {...props} />
        </>
    );
}

export function toRawWebSocketTone(status: WebSocketDiagnostic['status']): 'good' | 'bad' | 'muted' {
    if (status === 'open') {
        return 'good';
    }
    return status === 'error' ? 'bad' : 'muted';
}

function WebSocketRoutePreviewPanel({ model }: Pick<WebSocketCommandCenterViewProps, 'model'>) {
    const { routePreview } = model;
    return (
        <div className="websocket-route-preview" aria-label="WebSocket route preview">
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
    );
}

function WebSocketReceivedMessagesPanel({ model, state, authSession }: WebSocketCommandCenterViewProps) {
    const { subscription, diagnostics } = model;
    return (
        <div className="websocket-received-panel" aria-label="Received WebSocket messages">
            <div className="websocket-received-heading">
                <div>
                    <h3>Received WS Messages</h3>
                    <p>{model.receiveStatusText}</p>
                </div>
                <span className={`pill ${model.subscriptionStatusTone}`}>{model.subscriptionStatusLabel}</span>
            </div>
            <div className="websocket-received-summary">
                <Metric label="Listening group" value={subscription?.groupId || '-'} />
                <Metric label="Listening selector" value={subscription?.label ?? '-'} />
                <Metric label="Received" value={String(diagnostics.receivedMessages.length)} />
                <Metric label="Listening since" value={formatTime(subscription?.subscribedAtEpochMs)} />
                <Metric label="Last received" value={formatTime(diagnostics.receivedMessages.at(-1)?.atEpochMs)} />
            </div>
            <div className="websocket-received-list">
                {diagnostics.receivedMessages.length === 0 && (
                    <div className="empty-state">No received WebSocket messages</div>
                )}
                {diagnostics.receivedMessages.slice().reverse().map((message) => (
                    <article className="websocket-received-row" key={message.eventId}>
                        <div>
                            <strong>{message.topicId} / {message.typeId}</strong>
                            <small>
                                {formatTime(message.atEpochMs)} - group {message.roomId} - sender {message.senderId}
                            </small>
                            <small>context {message.contextId} - resource {message.resourceId}</small>
                        </div>
                        <pre className="mini-json">{redactedJson(message.payload, state, authSession)}</pre>
                    </article>
                ))}
            </div>
        </div>
    );
}

function WebSocketStatusMetrics({ model, browserStatus }: WebSocketCommandCenterViewProps) {
    const { diagnostics, values, subscription, ticket } = model;
    const rallarSendAvailable = model.canSendViaRallarSignaling || diagnostics.status === 'open';
    return (
        <div className="websocket-status-grid">
            <Metric label="Provider" value={model.providerMode} />
            <Metric label="Raw WS" value={diagnostics.statusLabel} tone={toRawWebSocketTone(diagnostics.status)} />
            <Metric label="Signal WS" value={browserStatus.signalingLabel} tone={browserStatus.signalingTone} />
            <Metric
                label="Rallar WS send"
                value={rallarSendAvailable ? 'available' : '-'}
                tone={rallarSendAvailable ? 'good' : 'muted'}
            />
            <Metric label="Raw ready state" value={diagnostics.readyState} />
            <Metric label="Inbound" value={String(diagnostics.inboundCount)} />
            <Metric label="Outbound" value={String(diagnostics.outboundCount)} />
            <Metric
                label="Errors"
                value={String(diagnostics.errorCount)}
                tone={diagnostics.errorCount > 0 ? 'bad' : 'good'}
            />
            <Metric label="Wait" value={model.waitStatus} />
            <Metric label="Group" value={values.groupId || '-'} />
            <Metric label="Selector" value={`${values.topicId || '*'} / ${values.typeId || '-'}`} />
            <Metric label="Subscription" value={subscription?.label ?? '-'} />
            <Metric label="Ticket" value={ticket ? 'redacted' : '-'} />
            <Metric label="Ticket expires" value={formatTime(ticket?.expiresAtEpochMs)} />
            <Metric label="Last open" value={formatTime(diagnostics.lastOpenAtEpochMs)} />
            <Metric label="Last close" value={formatTime(diagnostics.lastCloseAtEpochMs)} />
            <Metric label="Close code" value={String(diagnostics.closeCode ?? '-')} />
            <Metric label="Close reason" value={String(diagnostics.closeReason ?? '-')} />
        </div>
    );
}

function WebSocketCommandCenterNotices({ model }: Pick<WebSocketCommandCenterViewProps, 'model'>) {
    const error = model.localError || (model.payloadResult.ok ? undefined : model.payloadResult.error);
    return (
        <>
            {error ? <div className="workbench-error" role="status">{error}</div> : null}
            {model.canSendViaRallarSignaling && !model.localError && (
                <div className="command-center-status" role="status">
                    Send JSON uses rallar.messages.ws.send and connects Rallar signaling if needed. Open is only for raw
                    WebSocket checks.
                </div>
            )}
        </>
    );
}

function WebSocketEventLog({ model, state, authSession }: WebSocketCommandCenterViewProps) {
    const { recentEvents } = model.diagnostics;
    return (
        <>
            <div className="websocket-event-log-heading">
                <h3>WebSocket Event Log</h3>
                <span>{recentEvents.length} recent</span>
            </div>
            <div className="websocket-event-list">
                {recentEvents.length === 0 && <div className="empty-state">No WebSocket events yet</div>}
                {recentEvents.slice().reverse().map((event) => (
                    <article className="websocket-event-row" key={event.eventId}>
                        <div>
                            <strong>{event.topic}</strong>
                            <small>{formatTime(event.atEpochMs)} - {event.kind}</small>
                        </div>
                        <span className={`pill ${toEventTone(event.severity, event.kind)}`}>{event.severity}</span>
                        <pre className="mini-json">{redactedJson(event.payload, state, authSession)}</pre>
                    </article>
                ))}
            </div>
        </>
    );
}

function toEventTone(severity: string, kind: string): 'bad' | 'good' | 'muted' {
    if (severity === 'error') {
        return 'bad';
    }
    return kind === 'message' ? 'good' : 'muted';
}
