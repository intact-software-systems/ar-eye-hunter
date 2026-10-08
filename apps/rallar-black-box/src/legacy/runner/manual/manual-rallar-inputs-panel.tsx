import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';

import {
    MANUAL_PAYLOAD_PRESETS,
    type ManualDeliveryMode,
    type ManualWorkbenchValues
} from '../../../manual-workbench.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import type { ManualRallarWorkbenchModel } from './use-manual-rallar-workbench.ts';

export interface ManualRallarInputsPanelProps {
    readonly busy: boolean;
    readonly model: ManualRallarWorkbenchModel;
}

interface ManualTextFieldProps extends ManualRallarInputsPanelProps {
    readonly label: string;
    readonly field: keyof Pick<
        ManualWorkbenchValues,
        | 'environment'
        | 'apiBaseUrl'
        | 'applicationId'
        | 'workspaceId'
        | 'actor'
        | 'sessionId'
        | 'groupId'
        | 'scopeText'
        | 'roomRefText'
        | 'connection'
        | 'targetClient'
        | 'multicastClients'
        | 'wsUrl'
        | 'topic'
        | 'typeId'
        | 'topicId'
    >;
    readonly disabled?: boolean;
    readonly placeholder?: string;
}

const MANUAL_DELIVERY_MODES: readonly ManualDeliveryMode[] = ['direct', 'multicast', 'broadcast'];

export function ManualRallarInputsPanel(props: ManualRallarInputsPanelProps) {
    const { model } = props;
    return (
        <>
            <CollapsiblePanelSection
                title="Manual Rallar Inputs"
                meta={`${model.values.groupId || '-'} / ${model.values.transport}`}
            >
                <div className="manual-rallar-grid">
                    <ManualScopeFields {...props} />
                    <ManualConnectionFields {...props} />
                    <ManualRtcCapturePreference {...props} />
                    <ManualRtcReadinessPreference {...props} />
                    <ManualDeliveryFields {...props} />
                </div>
                <ManualDeliveryToggle {...props} />
            </CollapsiblePanelSection>
            <ManualPayloadFields {...props} />
        </>
    );
}

function ManualScopeFields(props: ManualRallarInputsPanelProps) {
    const { busy, model } = props;
    return (
        <>
            <ManualTextField {...props} label="Environment" field="environment" />
            <ManualTextField {...props} label="API Base URL" field="apiBaseUrl" />
            <ManualTextField {...props} label="Application" field="applicationId" />
            <ManualTextField {...props} label="Workspace" field="workspaceId" />
            <ManualTextField {...props} label="Actor" field="actor" />
            <ManualTextField {...props} label="Session" field="sessionId" />
            <ManualTextField {...props} label="Group" field="groupId" />
            <ManualTextField {...props} label="Scope JSON" field="scopeText" placeholder='{"workspaceId":"default"}' />
            <ManualTextField
                {...props}
                label="Room Ref JSON"
                field="roomRefText"
                placeholder='{"applicationId":"my-app","workspaceId":"default","groupId":"bb-group"}'
            />
            <label className="field">
                <span>Min Snapshot</span>
                <input
                    type="number"
                    min={0}
                    value={model.values.minSnapshotVersion}
                    onChange={(event) => model.updateValue('minSnapshotVersion', Number(event.target.value))}
                    disabled={busy}
                />
            </label>
        </>
    );
}

function ManualConnectionFields(props: ManualRallarInputsPanelProps) {
    const { busy, model } = props;
    return (
        <>
            <ManualTextField {...props} label="Connection" field="connection" />
            <label className="field">
                <span>Transport</span>
                <select
                    value={model.values.transport}
                    onChange={(event) => {
                        const transport = event.target.value;
                        if (transport === 'realtime' || transport === 'messages.rtc' || transport === 'ws') {
                            model.updateValue('transport', transport);
                        }
                    }}
                    disabled={busy}
                >
                    <option value="realtime">RTC realtime</option>
                    <option value="messages.rtc">RTC messages</option>
                    <option value="ws">WebSocket</option>
                </select>
            </label>
            <label className="field">
                <span>Timeout</span>
                <input
                    type="number"
                    min={0}
                    value={model.values.timeoutMs}
                    onChange={(event) => model.updateValue('timeoutMs', Number(event.target.value))}
                    disabled={busy}
                />
            </label>
        </>
    );
}

function ManualRtcCapturePreference({ busy, model }: ManualRallarInputsPanelProps) {
    return (
        <div>
            <label className="field">
                <span>RTC capture</span>
                <select
                    value={model.values.rtcCaptureMode ?? ''}
                    onChange={(event) => {
                        const value = event.target.value;
                        parseRtcCaptureMode(value === '' ? undefined : value).foldRight(({ mode }) =>
                            model.updateValue('rtcCaptureMode', mode)
                        );
                    }}
                    disabled={busy}
                >
                    <option value="">Inherit</option>
                    <option value="off">Off</option>
                    <option value="signaling">Signaling</option>
                    <option value="native">Full native</option>
                </select>
            </label>
            <p aria-label="Desired RTC capture">
                {model.values.rtcCaptureMode === undefined
                    ? 'Inherited capture preference'
                    : `Explicit ${model.values.rtcCaptureMode} capture preference`}
            </p>
        </div>
    );
}

function ManualRtcReadinessPreference({ busy, model }: ManualRallarInputsPanelProps) {
    const error = model.rtcReadinessResult.left;
    return (
        <div>
            <label className="json-editor">
                <span>RTC readiness JSON</span>
                <textarea
                    value={model.values.rtcReadinessText}
                    onChange={(event) => model.updateValue('rtcReadinessText', event.target.value)}
                    spellCheck={false}
                    disabled={busy || model.values.transport === 'ws'}
                    aria-invalid={error !== undefined}
                />
            </label>
            <p>
                Empty skips the readiness wait; {'{}'}{' '}
                uses the existing runtime defaults. Counts ready peers; it does not guarantee a named target is ready.
            </p>
            {error !== undefined && <p role="alert">{error}</p>}
        </div>
    );
}

function ManualDeliveryFields(props: ManualRallarInputsPanelProps) {
    const { values } = props.model;
    return (
        <>
            <ManualTextField
                {...props}
                label="Target Client"
                field="targetClient"
                disabled={values.deliveryMode !== 'direct'}
            />
            <ManualTextField
                {...props}
                label="Multicast Clients"
                field="multicastClients"
                disabled={values.deliveryMode !== 'multicast'}
            />
            <ManualTextField {...props} label="WS URL" field="wsUrl" disabled={values.transport !== 'ws'} />
            <ManualTextField {...props} label="Topic" field="topic" />
            <ManualTextField {...props} label="Type ID" field="typeId" disabled={values.transport !== 'messages.rtc'} />
            <ManualTextField
                {...props}
                label="Topic ID"
                field="topicId"
                disabled={values.transport !== 'messages.rtc'}
            />
        </>
    );
}

function ManualDeliveryToggle({ busy, model }: ManualRallarInputsPanelProps) {
    return (
        <div className="segmented delivery-toggle" role="group" aria-label="Delivery mode">
            {MANUAL_DELIVERY_MODES.map((mode) => (
                <button
                    key={mode}
                    type="button"
                    className={model.values.deliveryMode === mode ? 'selected' : ''}
                    onClick={() => model.updateValue('deliveryMode', mode)}
                    disabled={busy}
                >
                    {mode}
                </button>
            ))}
        </div>
    );
}

function ManualPayloadFields({ busy, model }: ManualRallarInputsPanelProps) {
    return (
        <CollapsiblePanelSection
            title="Manual Payload"
            meta={model.payloadResult.foldRight(() => 'json valid') ?? 'json invalid'}
        >
            <div className="payload-toolbar">
                <label className="field compact-field">
                    <span>Payload Preset</span>
                    <select
                        value={model.payloadPresetId}
                        onChange={(event) => model.selectPreset(event.target.value)}
                        disabled={busy}
                    >
                        <option value="custom">Custom</option>
                        {MANUAL_PAYLOAD_PRESETS.map((preset) => (
                            <option key={preset.presetId} value={preset.presetId}>{preset.label}</option>
                        ))}
                    </select>
                </label>
            </div>
            <label className="json-editor manual-payload-editor">
                <span>Payload JSON</span>
                <textarea
                    value={model.payloadText}
                    onChange={(event) => {
                        model.setPayloadPresetId('custom');
                        model.setPayloadText(event.target.value);
                    }}
                    spellCheck={false}
                    disabled={busy}
                />
            </label>
        </CollapsiblePanelSection>
    );
}

function ManualTextField({ label, field, busy, model, disabled, placeholder }: ManualTextFieldProps) {
    return (
        <label className="field">
            <span>{label}</span>
            <input
                value={model.values[field]}
                onChange={(event) => model.updateValue(field, event.target.value)}
                disabled={busy || disabled}
                placeholder={placeholder}
            />
        </label>
    );
}
