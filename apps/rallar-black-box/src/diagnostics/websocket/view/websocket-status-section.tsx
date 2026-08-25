import { Metric } from '../../../legacy/shared/Metric.tsx';
import { formatTime } from '../../../legacy/shared/time-format.ts';
import type { RallarBrowserStatusSummary } from '../../../legacy/shell/rallar-browser-status.ts';
import type { WebSocketCommandCenterViewModel } from './web-socket-command-center-view-model.ts';

export interface WebSocketStatusSectionProps {
    readonly browserStatus: RallarBrowserStatusSummary;
    readonly model: WebSocketCommandCenterViewModel;
}

export function WebSocketStatusSection({ browserStatus, model }: WebSocketStatusSectionProps) {
    const signalingAvailable = model.canSendViaRallarSignaling || model.diagnostics.status === 'open';
    return (
        <>
            <div className="websocket-status-grid">
                <WebSocketConnectionMetrics
                    browserStatus={browserStatus}
                    model={model}
                    signalingAvailable={signalingAvailable}
                />
                <WebSocketDiagnosticMetrics model={model} />
            </div>
            <WebSocketStatusMessage model={model} />
        </>
    );
}

export function WebSocketLiveSubscriptionStatus({ browserStatus, model }: WebSocketStatusSectionProps) {
    return (
        <div className="command-center-live-grid" aria-label="WebSocket live subscription status">
            <Metric
                label="WS subscribed"
                value={model.subscription ? 'yes' : 'no'}
                tone={model.subscription ? 'good' : 'warn'}
            />
            <Metric label="Subscribed group" value={model.subscription?.groupId || '-'} />
            <Metric label="Subscribed selector" value={model.subscription?.label ?? '-'} />
            <Metric label="Subscribed since" value={formatTime(model.subscription?.subscribedAtEpochMs)} />
            <Metric label="Signal WS" value={browserStatus.signalingLabel} tone={browserStatus.signalingTone} />
            <Metric
                label="Raw WS"
                value={model.diagnostics.statusLabel}
                tone={model.diagnostics.status === 'open'
                    ? 'good'
                    : model.diagnostics.status === 'error'
                    ? 'bad'
                    : 'muted'}
            />
        </div>
    );
}

interface WebSocketConnectionMetricsProps extends WebSocketStatusSectionProps {
    readonly signalingAvailable: boolean;
}

function WebSocketConnectionMetrics(props: WebSocketConnectionMetricsProps) {
    const { browserStatus, model } = props;
    return (
        <>
            <Metric label="Provider" value={model.providerMode} />
            <Metric
                label="Raw WS"
                value={model.diagnostics.statusLabel}
                tone={model.diagnostics.status === 'open'
                    ? 'good'
                    : model.diagnostics.status === 'error'
                    ? 'bad'
                    : 'muted'}
            />
            <Metric label="Signal WS" value={browserStatus.signalingLabel} tone={browserStatus.signalingTone} />
            <Metric
                label="Rallar WS send"
                value={props.signalingAvailable ? 'available' : '-'}
                tone={props.signalingAvailable ? 'good' : 'muted'}
            />
            <Metric label="Raw ready state" value={model.diagnostics.readyState} />
            <Metric label="Inbound" value={String(model.diagnostics.inboundCount)} />
            <Metric label="Outbound" value={String(model.diagnostics.outboundCount)} />
            <Metric
                label="Errors"
                value={String(model.diagnostics.errorCount)}
                tone={model.diagnostics.errorCount > 0 ? 'bad' : 'good'}
            />
        </>
    );
}

function WebSocketDiagnosticMetrics({ model }: Pick<WebSocketStatusSectionProps, 'model'>) {
    return (
        <>
            <Metric label="Wait" value={model.waitStatus} />
            <Metric label="Group" value={model.values.groupId || '-'} />
            <Metric label="Selector" value={`${model.values.topicId || '*'} / ${model.values.typeId || '-'}`} />
            <Metric label="Subscription" value={model.subscription?.label ?? '-'} />
            <Metric label="Ticket" value={model.ticket ? 'redacted' : '-'} />
            <Metric label="Ticket expires" value={formatTime(model.ticket?.expiresAtEpochMs)} />
            <Metric label="Last open" value={formatTime(model.diagnostics.lastOpenAtEpochMs)} />
            <Metric label="Last close" value={formatTime(model.diagnostics.lastCloseAtEpochMs)} />
            <Metric label="Close code" value={String(model.diagnostics.closeCode ?? '-')} />
            <Metric label="Close reason" value={String(model.diagnostics.closeReason ?? '-')} />
        </>
    );
}

function WebSocketStatusMessage({ model }: Pick<WebSocketStatusSectionProps, 'model'>) {
    if (model.localError || !model.payloadResult.ok) {
        return (
            <div className="workbench-error" role="status">
                {model.localError ?? (!model.payloadResult.ok ? model.payloadResult.error : undefined)}
            </div>
        );
    }
    return model.canSendViaRallarSignaling
        ? (
            <div className="command-center-status" role="status">
                Send JSON uses rallar.messages.ws.send and connects Rallar signaling if needed. Open is only for raw
                WebSocket checks.
            </div>
        )
        : null;
}
