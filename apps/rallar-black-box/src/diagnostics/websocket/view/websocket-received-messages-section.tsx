import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { Metric } from '../../../legacy/shared/Metric.tsx';
import { redactedJson } from '../../../legacy/shared/redaction-presentation.ts';
import { formatTime } from '../../../legacy/shared/time-format.ts';
import type { WebSocketReceivedMessageRow } from '../websocket-contracts.ts';
import type { WebSocketCommandCenterViewModel } from './web-socket-command-center-view-model.ts';

export interface WebSocketReceivedMessagesSectionProps {
    readonly state: RallarBlackBoxTestState;
    readonly authSession: AuthSession | undefined;
    readonly model: WebSocketCommandCenterViewModel;
}

interface WebSocketReceivedMessageProps {
    readonly state: RallarBlackBoxTestState;
    readonly authSession: AuthSession | undefined;
    readonly message: WebSocketReceivedMessageRow;
}

export function WebSocketReceivedMessagesSection(props: WebSocketReceivedMessagesSectionProps) {
    const { model } = props;
    return (
        <div className="websocket-received-panel" aria-label="Received WebSocket messages">
            <div className="websocket-received-heading">
                <div>
                    <h3>Received WS Messages</h3>
                    <p>{model.receiveStatusText}</p>
                </div>
                <span className={`pill ${model.subscriptionStatusTone}`}>{model.subscriptionStatusLabel}</span>
            </div>
            <WebSocketReceivedSummary model={model} />
            <div className="websocket-received-list">
                {model.diagnostics.receivedMessages.length === 0 && (
                    <div className="empty-state">No received WebSocket messages</div>
                )}
                {model.diagnostics.receivedMessages.slice().reverse().map((message) => (
                    <WebSocketReceivedMessage
                        key={message.eventId}
                        state={props.state}
                        authSession={props.authSession}
                        message={message}
                    />
                ))}
            </div>
        </div>
    );
}

function WebSocketReceivedSummary({ model }: Pick<WebSocketReceivedMessagesSectionProps, 'model'>) {
    return (
        <div className="websocket-received-summary">
            <Metric label="Listening group" value={model.subscription?.groupId || '-'} />
            <Metric label="Listening selector" value={model.subscription?.label ?? '-'} />
            <Metric label="Received" value={String(model.diagnostics.receivedMessages.length)} />
            <Metric label="Listening since" value={formatTime(model.subscription?.subscribedAtEpochMs)} />
            <Metric label="Last received" value={formatTime(model.diagnostics.receivedMessages.at(-1)?.atEpochMs)} />
        </div>
    );
}

function WebSocketReceivedMessage(props: WebSocketReceivedMessageProps) {
    const { message } = props;
    return (
        <article className="websocket-received-row">
            <div>
                <strong>{message.topicId} / {message.typeId}</strong>
                <small>{formatTime(message.atEpochMs)} - group {message.roomId} - sender {message.senderId}</small>
                <small>context {message.contextId} - resource {message.resourceId}</small>
            </div>
            <pre className="mini-json">{redactedJson(message.payload, props.state, props.authSession)}</pre>
        </article>
    );
}
