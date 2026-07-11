import {
    MANUAL_PAYLOAD_PRESETS,
    type ManualDeliveryMode,
    type ManualWorkbenchTransport,
} from '../../../manual-workbench.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import type { ManualRallarWorkbenchModel } from './use-manual-rallar-workbench.ts';

export function ManualRallarInputsPanel({
    busy,
    model,
}: {
    busy: boolean;
    model: ManualRallarWorkbenchModel;
}) {
    const {
        values,
        payloadResult,
        payloadPresetId,
        payloadText,
        updateValue,
        selectPreset,
        setPayloadPresetId,
        setPayloadText,
    } = model;

    return (
        <>
            <CollapsiblePanelSection
                title="Manual Rallar Inputs"
                meta={`${values.groupId || '-'} / ${values.transport}`}
            >
                <div className="manual-rallar-grid">
                    <label className="field">
                        <span>Environment</span>
                        <input
                            value={values.environment}
                            onChange={(event) =>
                                updateValue('environment', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={values.apiBaseUrl}
                            onChange={(event) =>
                                updateValue('apiBaseUrl', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Application</span>
                        <input
                            value={values.applicationId}
                            onChange={(event) =>
                                updateValue('applicationId', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Workspace</span>
                        <input
                            value={values.workspaceId}
                            onChange={(event) =>
                                updateValue('workspaceId', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Actor</span>
                        <input
                            value={values.actor}
                            onChange={(event) =>
                                updateValue('actor', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Session</span>
                        <input
                            value={values.sessionId}
                            onChange={(event) =>
                                updateValue('sessionId', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Group</span>
                        <input
                            value={values.groupId}
                            onChange={(event) =>
                                updateValue('groupId', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Scope JSON</span>
                        <input
                            value={values.scopeText}
                            onChange={(event) =>
                                updateValue('scopeText', event.target.value)
                            }
                            disabled={busy}
                            placeholder='{"workspaceId":"default"}'
                        />
                    </label>
                    <label className="field">
                        <span>Room Ref JSON</span>
                        <input
                            value={values.roomRefText}
                            onChange={(event) =>
                                updateValue('roomRefText', event.target.value)
                            }
                            disabled={busy}
                            placeholder='{"groupId":"bb-group"}'
                        />
                    </label>
                    <label className="field">
                        <span>Min Snapshot</span>
                        <input
                            type="number"
                            min={0}
                            value={values.minSnapshotVersion}
                            onChange={(event) =>
                                updateValue(
                                    'minSnapshotVersion',
                                    Number(event.target.value),
                                )
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Connection</span>
                        <input
                            value={values.connection}
                            onChange={(event) =>
                                updateValue('connection', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Transport</span>
                        <select
                            value={values.transport}
                            onChange={(event) =>
                                updateValue(
                                    'transport',
                                    event.target
                                        .value as ManualWorkbenchTransport,
                                )
                            }
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
                            value={values.timeoutMs}
                            onChange={(event) =>
                                updateValue(
                                    'timeoutMs',
                                    Number(event.target.value),
                                )
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Target Client</span>
                        <input
                            value={values.targetClient}
                            onChange={(event) =>
                                updateValue('targetClient', event.target.value)
                            }
                            disabled={busy || values.deliveryMode !== 'direct'}
                        />
                    </label>
                    <label className="field">
                        <span>Multicast Clients</span>
                        <input
                            value={values.multicastClients}
                            onChange={(event) =>
                                updateValue(
                                    'multicastClients',
                                    event.target.value,
                                )
                            }
                            disabled={
                                busy || values.deliveryMode !== 'multicast'
                            }
                        />
                    </label>
                    <label className="field">
                        <span>WS URL</span>
                        <input
                            value={values.wsUrl}
                            onChange={(event) =>
                                updateValue('wsUrl', event.target.value)
                            }
                            disabled={busy || values.transport !== 'ws'}
                        />
                    </label>
                    <label className="field">
                        <span>Topic</span>
                        <input
                            value={values.topic}
                            onChange={(event) =>
                                updateValue('topic', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Type ID</span>
                        <input
                            value={values.typeId}
                            onChange={(event) =>
                                updateValue('typeId', event.target.value)
                            }
                            disabled={
                                busy || values.transport !== 'messages.rtc'
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Topic ID</span>
                        <input
                            value={values.topicId}
                            onChange={(event) =>
                                updateValue('topicId', event.target.value)
                            }
                            disabled={
                                busy || values.transport !== 'messages.rtc'
                            }
                        />
                    </label>
                </div>
                <div
                    className="segmented delivery-toggle"
                    role="group"
                    aria-label="Delivery mode"
                >
                    {(['direct', 'multicast', 'broadcast'] as const).map(
                        (mode) => (
                            <button
                                key={mode}
                                type="button"
                                className={
                                    values.deliveryMode === mode
                                        ? 'selected'
                                        : ''
                                }
                                onClick={() =>
                                    updateValue(
                                        'deliveryMode',
                                        mode as ManualDeliveryMode,
                                    )
                                }
                                disabled={busy}
                            >
                                {mode}
                            </button>
                        ),
                    )}
                </div>
            </CollapsiblePanelSection>
            <CollapsiblePanelSection
                title="Manual Payload"
                meta={payloadResult.ok ? 'json valid' : 'json invalid'}
            >
                <div className="payload-toolbar">
                    <label className="field compact-field">
                        <span>Payload Preset</span>
                        <select
                            value={payloadPresetId}
                            onChange={(event) =>
                                selectPreset(event.target.value)
                            }
                            disabled={busy}
                        >
                            <option value="custom">Custom</option>
                            {MANUAL_PAYLOAD_PRESETS.map((preset) => (
                                <option
                                    key={preset.presetId}
                                    value={preset.presetId}
                                >
                                    {preset.label}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
                <label className="json-editor manual-payload-editor">
                    <span>Payload JSON</span>
                    <textarea
                        value={payloadText}
                        onChange={(event) => {
                            setPayloadPresetId('custom');
                            setPayloadText(event.target.value);
                        }}
                        spellCheck={false}
                        disabled={busy}
                    />
                </label>
            </CollapsiblePanelSection>
        </>
    );
}
