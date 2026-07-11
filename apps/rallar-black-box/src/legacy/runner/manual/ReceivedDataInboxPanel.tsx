import { useMemo } from 'react';
import { selectRallarBlackBoxEvents } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { deriveManualReceivedMessages } from '../../../manual-workbench.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { formatTime } from '../../shared/time-format.ts';

export function ReceivedDataInboxPanel({
    state,
    onSelectCommand,
}: {
    state: RallarBlackBoxTestState;
    onSelectCommand(commandId: string): void;
}) {
    const received = useMemo(
        () => deriveManualReceivedMessages(selectRallarBlackBoxEvents(state)),
        [state],
    );

    return (
        <section className="panel received-inbox-panel">
            <div className="panel-heading">
                <h2>Received Data</h2>
                <span>{received.length} messages</span>
            </div>
            <div className="received-list">
                {received.length === 0 && (
                    <div className="empty-state">No received data</div>
                )}
                {received
                    .slice(-24)
                    .reverse()
                    .map((message) => (
                        <article className="received-row" key={message.eventId}>
                            <div className="received-topline">
                                <strong>{message.topic}</strong>
                                <time>{formatTime(message.atEpochMs)}</time>
                            </div>
                            <div className="event-meta">
                                <span>{message.connection}</span>
                                <span>{message.transport}</span>
                                <span>{message.sender}</span>
                                {message.commandId && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            onSelectCommand(message.commandId!)
                                        }
                                    >
                                        {message.commandId}
                                    </button>
                                )}
                            </div>
                            <pre className="mini-json">
                                {redactedJson(message.payload, state)}
                            </pre>
                        </article>
                    ))}
            </div>
        </section>
    );
}
