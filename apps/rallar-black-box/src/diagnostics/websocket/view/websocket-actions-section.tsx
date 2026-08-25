import type { AuthSession } from '@shared/api/api-config.ts';

import { defaultWebSocketApiUrl } from '../websocket-url-routing.ts';
import type { WebSocketCommandCenterViewModel } from './web-socket-command-center-view-model.ts';

export interface WebSocketActionsSectionProps {
    readonly authSession: AuthSession | undefined;
    readonly busy: boolean;
    readonly model: WebSocketCommandCenterViewModel;
}

interface WebSocketActionButtonProps {
    readonly label: string;
    readonly disabled?: boolean;
    readonly onClick: () => void;
}

export function WebSocketActionsSection(props: WebSocketActionsSectionProps) {
    return (
        <>
            <RallarWebSocketActions {...props} />
            <RawWebSocketActions {...props} />
        </>
    );
}

function RallarWebSocketActions({ authSession, busy, model }: WebSocketActionsSectionProps) {
    const actionBusy = busy || Boolean(model.busyAction);
    const rallarUnavailable = actionBusy || model.providerMode !== 'browser-rallar' || !authSession;
    return (
        <div className="websocket-action-section">
            <div className="section-heading">
                <h3>Rallar WS Messages</h3>
                <span>rallar.messages.ws</span>
            </div>
            <div className="websocket-action-grid">
                <WebSocketActionButton
                    label={model.routePreview.sendLabel}
                    disabled={actionBusy}
                    onClick={() => void model.send()}
                />
                <WebSocketActionButton
                    label="Subscribe WS"
                    disabled={rallarUnavailable}
                    onClick={() => void model.subscribeWs()}
                />
                <WebSocketActionButton
                    label="Unsubscribe WS"
                    disabled={!model.subscription}
                    onClick={model.unsubscribeWs}
                />
                <WebSocketActionButton
                    label="Wait Rallar WS open"
                    disabled={rallarUnavailable}
                    onClick={() => void model.waitForRallarWsOpen()}
                />
                <WebSocketActionButton
                    label="Wait for message"
                    disabled={actionBusy}
                    onClick={() => void model.waitForMessage()}
                />
                <WebSocketActionButton label="Copy WS recipe" onClick={() => model.copyRecipe(false)} />
                <WebSocketActionButton label="Copy WS/RTC compare recipe" onClick={() => model.copyRecipe(true)} />
            </div>
        </div>
    );
}

function RawWebSocketActions({ authSession, busy, model }: WebSocketActionsSectionProps) {
    const actionBusy = busy || Boolean(model.busyAction);
    return (
        <div className="websocket-action-section">
            <div className="section-heading">
                <h3>Raw WebSocket Diagnostics</h3>
                <span>ticket/socket checks</span>
            </div>
            <div className="websocket-action-grid">
                <WebSocketActionButton
                    label="Configure WS"
                    disabled={actionBusy}
                    onClick={() => void model.configure()}
                />
                <WebSocketActionButton
                    label="Create WS ticket"
                    disabled={actionBusy || !authSession}
                    onClick={() => void model.createTicket()}
                />
                <WebSocketActionButton label="Open" disabled={actionBusy} onClick={() => void model.open()} />
                <WebSocketActionButton
                    label="Open API WS"
                    disabled={actionBusy}
                    onClick={() => void model.open(defaultWebSocketApiUrl(model.values.apiBaseUrl))}
                />
                <WebSocketActionButton label="Reconnect" disabled={actionBusy} onClick={() => void model.reconnect()} />
                <WebSocketActionButton label="Close" disabled={actionBusy} onClick={() => void model.close()} />
                <WebSocketActionButton label="Cleanup" disabled={actionBusy} onClick={() => void model.cleanup()} />
                <WebSocketActionButton
                    label="Missing ticket open"
                    disabled={actionBusy}
                    onClick={() => void model.openMissingTicket()}
                />
                <WebSocketActionButton label="Copy diagnostics" onClick={model.copyDiagnostics} />
            </div>
        </div>
    );
}

function WebSocketActionButton(props: WebSocketActionButtonProps) {
    return <button type="button" disabled={props.disabled} onClick={props.onClick}>{props.label}</button>;
}
