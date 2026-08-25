import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { CommandCenterActionFeedbackPanel } from '../../../legacy/diagnostics/shared/CommandCenterActionFeedbackPanel.tsx';
import type { RallarBrowserStatusSummary } from '../../../legacy/shell/rallar-browser-status.ts';
import type { WebSocketCommandCenterViewModel } from './web-socket-command-center-view-model.ts';
import { WebSocketActionsSection } from './websocket-actions-section.tsx';
import { WebSocketEventLog } from './websocket-event-log.tsx';
import { WebSocketInputsSection } from './websocket-inputs-section.tsx';
import { WebSocketPayloadRouteSection } from './websocket-payload-route-section.tsx';
import { WebSocketReceivedMessagesSection } from './websocket-received-messages-section.tsx';
import { WebSocketLiveSubscriptionStatus, WebSocketStatusSection } from './websocket-status-section.tsx';

export interface WebSocketCommandCenterViewProps {
    readonly state: RallarBlackBoxTestState;
    readonly authSession?: AuthSession;
    readonly browserStatus: RallarBrowserStatusSummary;
    readonly busy: boolean;
    readonly model: WebSocketCommandCenterViewModel;
}

export function WebSocketCommandCenterView(props: WebSocketCommandCenterViewProps) {
    const { model } = props;
    return (
        <section className="panel websocket-command-center-panel">
            <div className="panel-heading">
                <h2>WebSocket Command Center</h2>
                <span
                    className={`pill ${
                        model.diagnostics.status === 'error'
                            ? 'bad'
                            : model.diagnostics.status === 'open'
                            ? 'good'
                            : 'muted'
                    }`}
                >
                    {model.diagnostics.statusLabel}
                </span>
            </div>
            <WebSocketInputsSection model={model} />
            <CommandCenterActionFeedbackPanel
                feedback={model.actionFeedback}
                state={props.state}
                authSession={props.authSession}
            />
            <WebSocketLiveSubscriptionStatus browserStatus={props.browserStatus} model={model} />
            <WebSocketActionsSection authSession={props.authSession} busy={props.busy} model={model} />
            <WebSocketPayloadRouteSection model={model} />
            <WebSocketReceivedMessagesSection state={props.state} authSession={props.authSession} model={model} />
            <WebSocketStatusSection browserStatus={props.browserStatus} model={model} />
            <WebSocketEventLog state={props.state} authSession={props.authSession} model={model} />
        </section>
    );
}
