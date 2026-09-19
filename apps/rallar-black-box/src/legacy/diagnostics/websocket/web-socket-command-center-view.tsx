import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import { Metric } from '../../shared/Metric.tsx';
import { formatTime } from '../../shared/time-format.ts';
import { CommandCenterActionFeedbackPanel } from '../shared/CommandCenterActionFeedbackPanel.tsx';
import { toRawWebSocketTone, WebSocketCommandCenterEvidence } from './web-socket-command-center-evidence.tsx';
import type { WebSocketCommandCenterValues } from './websocket-contracts.ts';
import { WEBSOCKET_PAYLOAD_PRESETS } from './websocket-presets.ts';
import { defaultWebSocketApiUrl } from './websocket-routing.ts';
import type { WebSocketCommandCenterViewProps } from './websocket-view-contracts.ts';

type WebSocketTextKey = {
    [K in keyof WebSocketCommandCenterValues]: WebSocketCommandCenterValues[K] extends string ? K : never;
}[keyof WebSocketCommandCenterValues];

interface WebSocketTextFieldProps {
    readonly label: string;
    readonly value: string;
    readonly className: string;
    onChange(value: string): void;
}

interface WebSocketNumberFieldProps {
    readonly label: string;
    readonly value: number;
    readonly min: number | undefined;
    onChange(value: number): void;
}

export function WebSocketCommandCenterView(props: WebSocketCommandCenterViewProps) {
    const { model } = props;
    return (
        <section className="panel websocket-command-center-panel">
            <div className="panel-heading">
                <h2>WebSocket Command Center</h2>
                <span className={`pill ${toRawWebSocketTone(model.diagnostics.status)}`}>
                    {model.diagnostics.statusLabel}
                </span>
            </div>
            <WebSocketInputsSection model={model} />
            <CommandCenterActionFeedbackPanel
                feedback={model.actionFeedback}
                state={props.state}
                authSession={props.authSession}
            />
            <WebSocketLiveSubscriptionMetrics model={model} browserStatus={props.browserStatus} />
            <WebSocketMessageButtons {...props} />
            <WebSocketRawSocketButtons {...props} />
            <WebSocketPayloadSection model={model} />
            <WebSocketCommandCenterEvidence {...props} />
        </section>
    );
}

function WebSocketInputsSection({ model }: Pick<WebSocketCommandCenterViewProps, 'model'>) {
    const { values, updateValue } = model;
    const text = (label: string, key: WebSocketTextKey, className: string) => (
        <WebSocketTextField
            label={label}
            value={values[key]}
            className={className}
            onChange={(value) => updateValue(key, value)}
        />
    );
    return (
        <CollapsiblePanelSection title="WebSocket Inputs" meta={model.routePreview.destination}>
            <div className="websocket-context-grid">
                {text('API Base URL', 'apiBaseUrl', 'field')}
                {text('Connection', 'connection', 'field')}
                {text('Application', 'applicationId', 'field')}
                {text('Workspace', 'workspaceId', 'field')}
                <WebSocketTextField
                    label="Group"
                    value={values.groupId}
                    className="field"
                    onChange={model.updateGroupId}
                />
                <WebSocketScopeField model={model} />
                {text('Type ID', 'typeId', 'field')}
                {text('Topic ID', 'topicId', 'field')}
                {text('Context ID', 'contextId', 'field')}
                {text('Resource ID', 'resourceId', 'field')}
                {text('WebSocket URL', 'wsUrl', 'field websocket-url-field')}
                {text('Protocols', 'protocols', 'field')}
                <WebSocketNumberField
                    label="Timeout"
                    value={values.timeoutMs}
                    min={0}
                    onChange={(value) => updateValue('timeoutMs', value)}
                />
                <WebSocketNumberField
                    label="Close Code"
                    value={values.closeCode}
                    min={undefined}
                    onChange={(value) => updateValue('closeCode', value)}
                />
                {text('Close Reason', 'closeReason', 'field')}
            </div>
        </CollapsiblePanelSection>
    );
}

function WebSocketTextField({ label, value, className, onChange }: WebSocketTextFieldProps) {
    return (
        <label className={className}>
            <span>{label}</span>
            <input value={value} onChange={(event) => onChange(event.target.value)} />
        </label>
    );
}

function WebSocketNumberField({ label, value, min, onChange }: WebSocketNumberFieldProps) {
    return (
        <label className="field">
            <span>{label}</span>
            <input type="number" min={min} value={value} onChange={(event) => onChange(Number(event.target.value))} />
        </label>
    );
}

function WebSocketScopeField({ model }: Pick<WebSocketCommandCenterViewProps, 'model'>) {
    return (
        <label className="field">
            <span>WS Scope</span>
            <select
                value={model.values.wsScope}
                onChange={(event) => model.updateWsScope(event.target.value as WebSocketCommandCenterValues['wsScope'])}
            >
                <option value="room">room</option>
                <option value="all">all</option>
                <option value="world">world</option>
            </select>
        </label>
    );
}

function WebSocketLiveSubscriptionMetrics(
    { model, browserStatus }: Pick<WebSocketCommandCenterViewProps, 'model' | 'browserStatus'>
) {
    const { subscription, diagnostics } = model;
    return (
        <div className="command-center-live-grid" aria-label="WebSocket live subscription status">
            <Metric label="WS subscribed" value={subscription ? 'yes' : 'no'} tone={subscription ? 'good' : 'warn'} />
            <Metric label="Subscribed group" value={subscription?.groupId || '-'} />
            <Metric label="Subscribed selector" value={subscription?.label ?? '-'} />
            <Metric label="Subscribed since" value={formatTime(subscription?.subscribedAtEpochMs)} />
            <Metric label="Signal WS" value={browserStatus.signalingLabel} tone={browserStatus.signalingTone} />
            <Metric label="Raw WS" value={diagnostics.statusLabel} tone={toRawWebSocketTone(diagnostics.status)} />
        </div>
    );
}

function WebSocketMessageButtons({ model, busy, authSession }: WebSocketCommandCenterViewProps) {
    const blocked = busy || Boolean(model.busyAction);
    const rallarBlocked = blocked || model.providerMode !== 'browser-rallar' || !authSession;
    return (
        <div className="websocket-action-section">
            <div className="section-heading">
                <h3>Rallar WS Messages</h3>
                <span>rallar.messages.ws</span>
            </div>
            <div className="websocket-action-grid">
                <button type="button" disabled={blocked} onClick={() => void model.send()}>
                    {model.routePreview.sendLabel}
                </button>
                <button type="button" disabled={rallarBlocked} onClick={() => void model.subscribeWs()}>
                    Subscribe WS
                </button>
                <button type="button" disabled={!model.subscription} onClick={model.unsubscribeWs}>
                    Unsubscribe WS
                </button>
                <button type="button" disabled={rallarBlocked} onClick={() => void model.waitForRallarWsOpen()}>
                    Wait Rallar WS open
                </button>
                <button type="button" disabled={blocked} onClick={() => void model.waitForMessage()}>
                    Wait for message
                </button>
                <button type="button" onClick={() => void model.copyRecipe(false)}>
                    Copy WS recipe
                </button>
                <button type="button" onClick={() => void model.copyRecipe(true)}>
                    Copy WS/RTC compare recipe
                </button>
            </div>
        </div>
    );
}

function WebSocketRawSocketButtons({ model, busy, authSession }: WebSocketCommandCenterViewProps) {
    const blocked = busy || Boolean(model.busyAction);
    const { values } = model;
    return (
        <div className="websocket-action-section">
            <div className="section-heading">
                <h3>Raw WebSocket Diagnostics</h3>
                <span>ticket/socket checks</span>
            </div>
            <div className="websocket-action-grid">
                <button type="button" disabled={blocked} onClick={() => void model.configure()}>Configure WS</button>
                <button type="button" disabled={blocked || !authSession} onClick={() => void model.createTicket()}>
                    Create WS ticket
                </button>
                <button type="button" disabled={blocked} onClick={() => void model.open(values.wsUrl)}>Open</button>
                <button
                    type="button"
                    disabled={blocked}
                    onClick={() => void model.open(defaultWebSocketApiUrl(values.apiBaseUrl))}
                >
                    Open API WS
                </button>
                <button type="button" disabled={blocked} onClick={() => void model.reconnect()}>Reconnect</button>
                <button type="button" disabled={blocked} onClick={() => void model.close(values.closeReason)}>
                    Close
                </button>
                <button type="button" disabled={blocked} onClick={() => void model.cleanup()}>Cleanup</button>
                <button type="button" disabled={blocked} onClick={() => void model.openMissingTicket()}>
                    Missing ticket open
                </button>
                <button type="button" onClick={() => void model.copyDiagnostics()}>Copy diagnostics</button>
            </div>
        </div>
    );
}

function WebSocketPayloadSection({ model }: Pick<WebSocketCommandCenterViewProps, 'model'>) {
    return (
        <CollapsiblePanelSection title="WebSocket Payload" meta={model.activePreset.label}>
            <div className="websocket-payload-grid">
                <label className="field">
                    <span>Payload Preset</span>
                    <select
                        value={model.payloadPresetId}
                        onChange={(event) => model.selectPayloadPreset(event.target.value)}
                    >
                        {WEBSOCKET_PAYLOAD_PRESETS.map((preset) => (
                            <option key={preset.presetId} value={preset.presetId}>{preset.label}</option>
                        ))}
                    </select>
                    <small>{model.activePreset.description}</small>
                </label>
                <label className="json-editor">
                    <span>Payload JSON</span>
                    <textarea
                        value={model.values.payloadText}
                        onChange={(event) => model.updateValue('payloadText', event.target.value)}
                        spellCheck={false}
                    />
                </label>
            </div>
        </CollapsiblePanelSection>
    );
}
