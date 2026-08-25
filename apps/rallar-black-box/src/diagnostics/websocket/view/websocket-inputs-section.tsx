import { CollapsiblePanelSection } from '../../../legacy/shared/CollapsiblePanelSection.tsx';
import type { WebSocketCommandCenterViewModel } from './web-socket-command-center-view-model.ts';

export interface WebSocketInputsSectionProps {
    readonly model: WebSocketCommandCenterViewModel;
}

interface WebSocketTextInputProps {
    readonly label: string;
    readonly value: string | number;
    readonly onChange: (value: string) => void;
    readonly type?: 'text' | 'number';
    readonly min?: number;
    readonly className?: string;
}

export function WebSocketInputsSection({ model }: WebSocketInputsSectionProps) {
    return (
        <CollapsiblePanelSection title="WebSocket Inputs" meta={model.routePreview.destination}>
            <div className="websocket-context-grid">
                <WebSocketIdentityInputs model={model} />
                <WebSocketTransportInputs model={model} />
            </div>
        </CollapsiblePanelSection>
    );
}

function WebSocketIdentityInputs({ model }: WebSocketInputsSectionProps) {
    return (
        <>
            <WebSocketTextInput
                label="API Base URL"
                value={model.values.apiBaseUrl}
                onChange={(value) => model.updateValue('apiBaseUrl', value)}
            />
            <WebSocketTextInput
                label="Connection"
                value={model.values.connection}
                onChange={(value) => model.updateValue('connection', value)}
            />
            <WebSocketTextInput
                label="Application"
                value={model.values.applicationId}
                onChange={(value) => model.updateValue('applicationId', value)}
            />
            <WebSocketTextInput
                label="Workspace"
                value={model.values.workspaceId}
                onChange={(value) => model.updateValue('workspaceId', value)}
            />
            <WebSocketTextInput label="Group" value={model.values.groupId} onChange={model.updateGroupId} />
            <label className="field">
                <span>WS Scope</span>
                <select
                    value={model.values.wsScope}
                    onChange={(event) => model.updateWsScope(event.target.value as typeof model.values.wsScope)}
                >
                    <option value="room">room</option>
                    <option value="all">all</option>
                    <option value="world">world</option>
                </select>
            </label>
            <WebSocketTextInput
                label="Type ID"
                value={model.values.typeId}
                onChange={(value) => model.updateValue('typeId', value)}
            />
            <WebSocketTextInput
                label="Topic ID"
                value={model.values.topicId}
                onChange={(value) => model.updateValue('topicId', value)}
            />
            <WebSocketTextInput
                label="Context ID"
                value={model.values.contextId}
                onChange={(value) => model.updateValue('contextId', value)}
            />
            <WebSocketTextInput
                label="Resource ID"
                value={model.values.resourceId}
                onChange={(value) => model.updateValue('resourceId', value)}
            />
        </>
    );
}

function WebSocketTransportInputs({ model }: WebSocketInputsSectionProps) {
    return (
        <>
            <WebSocketTextInput
                label="WebSocket URL"
                className="websocket-url-field"
                value={model.values.wsUrl}
                onChange={(value) => model.updateValue('wsUrl', value)}
            />
            <WebSocketTextInput
                label="Protocols"
                value={model.values.protocols}
                onChange={(value) => model.updateValue('protocols', value)}
            />
            <WebSocketTextInput
                label="Timeout"
                type="number"
                min={0}
                value={model.values.timeoutMs}
                onChange={(value) => model.updateValue('timeoutMs', Number(value))}
            />
            <WebSocketTextInput
                label="Close Code"
                type="number"
                value={model.values.closeCode}
                onChange={(value) => model.updateValue('closeCode', Number(value))}
            />
            <WebSocketTextInput
                label="Close Reason"
                value={model.values.closeReason}
                onChange={(value) => model.updateValue('closeReason', value)}
            />
        </>
    );
}

function WebSocketTextInput(props: WebSocketTextInputProps) {
    return (
        <label className={`field${props.className ? ` ${props.className}` : ''}`}>
            <span>{props.label}</span>
            <input
                type={props.type}
                min={props.min}
                value={props.value}
                onChange={(event) => props.onChange(event.target.value)}
            />
        </label>
    );
}
