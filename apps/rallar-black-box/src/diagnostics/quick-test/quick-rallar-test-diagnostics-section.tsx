import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { CollapsiblePanelSection } from '../../legacy/shared/CollapsiblePanelSection.tsx';
import { redactedJson } from '../../legacy/shared/redaction-presentation.ts';
import { formatTime } from '../../legacy/shared/time-format.ts';
import type { QuickRallarTestViewModel } from './quick-rallar-contracts.ts';
interface QuickRallarTestDiagnosticsSectionProps {
    readonly state: RallarBlackBoxTestState;
    readonly authSession?: AuthSession;
    readonly model: QuickRallarTestViewModel;
}
export function QuickRallarTestDiagnosticsSection(
    { state, authSession, model }: QuickRallarTestDiagnosticsSectionProps
) {
    return (
        <CollapsiblePanelSection title="Quick Test Payload" meta={`${model.receivedMessages.length} received`}>
            <div className="quick-rallar-payload-grid">
                <label className="json-editor">
                    <span>Payload JSON</span>
                    <textarea
                        value={model.values.payloadText}
                        onChange={(event) => model.updateValue('payloadText', event.target.value)}
                        spellCheck={false}
                    />
                </label>
                <div className="quick-rallar-received-panel" aria-label="Quick Test received messages">
                    <div className="websocket-received-heading">
                        <div>
                            <h3>Received Messages</h3>
                            <p>
                                {model.subscription
                                    ? `Listening to ${model.subscription.label} in ${model.subscription.groupId}.`
                                    : 'Not listening.'}
                            </p>
                        </div>
                        <span className={`pill ${model.subscription ? 'good' : 'muted'}`}>
                            {model.subscription ? 'listening' : 'idle'}
                        </span>
                    </div>
                    <div className="websocket-received-list">
                        {model.receivedMessages.length === 0 && <div className="empty-state">No received messages</div>}
                        {model.receivedMessages.slice().reverse().map((message) => (
                            <article className="websocket-received-row" key={message.rowId}>
                                <div>
                                    <strong>{message.topicId} / {message.typeId}</strong>
                                    <small>{formatTime(message.atEpochMs)} - group {message.roomId}</small>
                                    <small>sender {message.senderId} - context {message.contextId}</small>
                                </div>
                                <pre className="mini-json">{redactedJson(message.payload, state, authSession)}</pre>
                            </article>
                        ))}
                    </div>
                </div>
            </div>
        </CollapsiblePanelSection>
    );
}
