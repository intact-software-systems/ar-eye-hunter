import { CollapsiblePanelSection } from '../../../legacy/shared/CollapsiblePanelSection.tsx';
import { WEBSOCKET_PAYLOAD_PRESETS } from '../websocket-presets.ts';
import type { WebSocketCommandCenterViewModel } from './web-socket-command-center-view-model.ts';

export interface WebSocketPayloadRouteSectionProps {
    readonly model: WebSocketCommandCenterViewModel;
}

export function WebSocketPayloadRouteSection({ model }: WebSocketPayloadRouteSectionProps) {
    return (
        <>
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
            <WebSocketRoutePreview model={model} />
        </>
    );
}

function WebSocketRoutePreview({ model }: WebSocketPayloadRouteSectionProps) {
    return (
        <div className="websocket-route-preview" aria-label="WebSocket route preview">
            <div>
                <span>Destination</span>
                <strong>{model.routePreview.destination}</strong>
                <small>{model.routePreview.destinationDetail}</small>
            </div>
            <div>
                <span>Selector</span>
                <strong>{model.routePreview.selector}</strong>
                <small>{model.routePreview.selectorDetail}</small>
            </div>
            <div>
                <span>Transport</span>
                <strong>{model.routePreview.transport}</strong>
                <small>{model.routePreview.transportDetail}</small>
            </div>
        </div>
    );
}
