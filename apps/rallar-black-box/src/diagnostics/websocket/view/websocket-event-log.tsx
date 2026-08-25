import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { redactedJson } from '../../../legacy/shared/redaction-presentation.ts';
import { formatTime } from '../../../legacy/shared/time-format.ts';
import type { WebSocketEventRow } from '../websocket-contracts.ts';
import type { WebSocketCommandCenterViewModel } from './web-socket-command-center-view-model.ts';

export interface WebSocketEventLogProps {
    readonly state: RallarBlackBoxTestState;
    readonly authSession: AuthSession | undefined;
    readonly model: WebSocketCommandCenterViewModel;
}

interface WebSocketEventProps {
    readonly state: RallarBlackBoxTestState;
    readonly authSession: AuthSession | undefined;
    readonly event: WebSocketEventRow;
}

export function WebSocketEventLog(props: WebSocketEventLogProps) {
    return (
        <>
            <div className="websocket-event-log-heading">
                <h3>WebSocket Event Log</h3>
                <span>{props.model.diagnostics.recentEvents.length} recent</span>
            </div>
            <div className="websocket-event-list">
                {props.model.diagnostics.recentEvents.length === 0 && (
                    <div className="empty-state">No WebSocket events yet</div>
                )}
                {props.model.diagnostics.recentEvents.slice().reverse().map((event) => (
                    <WebSocketEvent
                        key={event.eventId}
                        state={props.state}
                        authSession={props.authSession}
                        event={event}
                    />
                ))}
            </div>
        </>
    );
}

function WebSocketEvent(props: WebSocketEventProps) {
    const tone = props.event.severity === 'error'
        ? 'bad'
        : props.event.kind === 'message'
        ? 'good'
        : 'muted';
    return (
        <article className="websocket-event-row">
            <div>
                <strong>{props.event.topic}</strong>
                <small>{formatTime(props.event.atEpochMs)} - {props.event.kind}</small>
            </div>
            <span className={`pill ${tone}`}>{props.event.severity}</span>
            <pre className="mini-json">{redactedJson(props.event.payload, props.state, props.authSession)}</pre>
        </article>
    );
}
