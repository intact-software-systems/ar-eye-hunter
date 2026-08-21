import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import { Metric } from '../../shared/Metric.tsx';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { formatTime } from '../../shared/time-format.ts';
import { CommandCenterActionFeedbackPanel } from '../shared/CommandCenterActionFeedbackPanel.tsx';
import type { RtcRealtimeTransport, RtcRealtimeViewModel } from './rtc-realtime-contracts.ts';

export function RtcRealtimeView({
    state,
    authSession,
    model
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
    model: RtcRealtimeViewModel;
}) {
    const {
        transport,
        setTransport,
        laneId,
        setLaneId,
        peerIdsText,
        setPeerIdsText,
        typeId,
        setTypeId,
        topicId,
        setTopicId,
        contextId,
        setContextId,
        payloadText,
        setPayloadText,
        minSnapshotVersion,
        setMinSnapshotVersion,
        reliability,
        setReliability,
        ack,
        setAck,
        ownership,
        setOwnership,
        timeoutMs,
        setTimeoutMs,
        busyAction,
        localError,
        actionFeedback,
        result,
        received,
        health,
        subscriptions,
        providerMode,
        realBackendReady,
        activeGroupId,
        peerIds,
        canRun,
        subscribeRealtime,
        subscribeRtcMessages,
        clearSubscriptions,
        sendRealtime,
        sendRtcMessage,
        waitForRoomLane,
        refreshHealth,
        copyRecipe
    } = model;

    return (
        <section
            className="panel rtc-realtime-panel"
            aria-label="RTC/Realtimes"
        >
            <div className="panel-heading">
                <h2>RTC/Realtimes</h2>
                <span className={`pill ${realBackendReady ? 'good' : 'warn'}`}>
                    {realBackendReady
                        ? 'direct Rallar'
                        : 'real backend required'}
                </span>
            </div>
            <div className="rtc-realtime-summary-grid">
                <Metric
                    label="Provider"
                    value={providerMode}
                    tone={realBackendReady ? 'good' : 'warn'}
                />
                <Metric
                    label="Group"
                    value={activeGroupId || '-'}
                    tone={activeGroupId ? 'good' : 'warn'}
                />
                <Metric label="Transport" value={transport} />
                <Metric label="Lane" value={laneId || '-'} />
                <Metric
                    label="Peer targets"
                    value={peerIds.length ? peerIds.join(', ') : 'room/default'}
                />
                <Metric
                    label="Subscriptions"
                    value={String(subscriptions.length)}
                />
                <Metric label="Received" value={String(received.length)} />
            </div>
            <CommandCenterActionFeedbackPanel
                feedback={actionFeedback}
                state={state}
                authSession={authSession}
            />
            <div
                className="command-center-live-grid"
                aria-label="RTC realtime subscription status"
            >
                <Metric
                    label="Realtime sub"
                    value={subscriptions.some(
                            (subscription) => subscription.transport === 'realtime'
                        )
                        ? 'yes'
                        : 'no'}
                    tone={subscriptions.some(
                            (subscription) => subscription.transport === 'realtime'
                        )
                        ? 'good'
                        : 'warn'}
                />
                <Metric
                    label="RTC message sub"
                    value={subscriptions.some(
                            (subscription) => subscription.transport === 'messages.rtc'
                        )
                        ? 'yes'
                        : 'no'}
                    tone={subscriptions.some(
                            (subscription) => subscription.transport === 'messages.rtc'
                        )
                        ? 'good'
                        : 'warn'}
                />
                <Metric
                    label="Subscribed group"
                    value={subscriptions.at(-1)?.groupId ?? '-'}
                />
                <Metric
                    label="Subscribed lane"
                    value={subscriptions.at(-1)?.laneId ?? '-'}
                />
                <Metric
                    label="Subscribed selector"
                    value={subscriptions.at(-1)?.label ?? '-'}
                />
                <Metric
                    label="Subscribed since"
                    value={formatTime(
                        subscriptions.at(-1)?.subscribedAtEpochMs
                    )}
                />
            </div>
            <CollapsiblePanelSection
                title="RTC/Realtimes Inputs"
                meta={`${activeGroupId || '-'} / ${transport}`}
            >
                <div className="rtc-realtime-context-grid">
                    <label className="field">
                        <span>Transport</span>
                        <select
                            value={transport}
                            onChange={(event) =>
                                setTransport(
                                    event.target.value as RtcRealtimeTransport
                                )}
                        >
                            <option value="realtime">realtime.sendJson</option>
                            <option value="messages.rtc">
                                messages.rtc.send
                            </option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Lane ID</span>
                        <input
                            value={laneId}
                            onChange={(event) => setLaneId(event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Peer IDs</span>
                        <input
                            value={peerIdsText}
                            onChange={(event) => setPeerIdsText(event.target.value)}
                            placeholder="comma separated"
                        />
                    </label>
                    <label className="field">
                        <span>Type ID</span>
                        <input
                            value={typeId}
                            onChange={(event) => setTypeId(event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Topic ID</span>
                        <input
                            value={topicId}
                            onChange={(event) => setTopicId(event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Context ID</span>
                        <input
                            value={contextId}
                            onChange={(event) => setContextId(event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Min Snapshot</span>
                        <input
                            value={minSnapshotVersion}
                            onChange={(event) => setMinSnapshotVersion(event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Timeout</span>
                        <input
                            type="number"
                            min={0}
                            value={timeoutMs}
                            onChange={(event) => setTimeoutMs(Number(event.target.value))}
                        />
                    </label>
                    <label className="field">
                        <span>Reliability</span>
                        <select
                            value={reliability}
                            onChange={(event) =>
                                setReliability(
                                    event.target.value as typeof reliability
                                )}
                        >
                            <option value="best-effort">best-effort</option>
                            <option value="at-least-once">at-least-once</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Ack</span>
                        <select
                            value={ack}
                            onChange={(event) => setAck(event.target.value as typeof ack)}
                        >
                            <option value="none">none</option>
                            <option value="receiver">receiver</option>
                            <option value="all-logical-recipients">
                                all-logical-recipients
                            </option>
                            <option value="group-leader">group-leader</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Ownership</span>
                        <select
                            value={ownership}
                            onChange={(event) =>
                                setOwnership(
                                    event.target.value as typeof ownership
                                )}
                        >
                            <option value="shared">shared</option>
                            <option value="exclusive">exclusive</option>
                        </select>
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div className="rtc-realtime-action-grid">
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void subscribeRealtime()}
                >
                    Subscribe realtime
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void subscribeRtcMessages()}
                >
                    Subscribe RTC messages
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void sendRealtime()}
                >
                    Send realtime JSON
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void sendRtcMessage()}
                >
                    Send RTC message
                </button>
                <button
                    type="button"
                    disabled={!canRun || !activeGroupId}
                    onClick={() => void waitForRoomLane()}
                >
                    Wait room lane
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void refreshHealth()}
                >
                    Refresh lane health
                </button>
                <button
                    type="button"
                    disabled={subscriptions.length === 0}
                    onClick={clearSubscriptions}
                >
                    Clear subscriptions
                </button>
                <button type="button" onClick={copyRecipe}>
                    Copy RTC recipe
                </button>
            </div>
            <CollapsiblePanelSection
                title="RTC/Realtimes Payload"
                meta={`${received.length} received`}
            >
                <div className="rtc-realtime-work-grid">
                    <label className="json-editor">
                        <span>Payload JSON</span>
                        <textarea
                            value={payloadText}
                            onChange={(event) => setPayloadText(event.target.value)}
                            spellCheck={false}
                        />
                    </label>
                    <section
                        className="rtc-realtime-received-panel"
                        aria-label="RTC/Realtimes received messages"
                    >
                        <div className="section-heading">
                            <h3>Received Messages</h3>
                            <span>{received.length} rows</span>
                        </div>
                        <div className="websocket-received-list">
                            {received.length === 0 && (
                                <div className="empty-state">
                                    No received RTC/Realtimes messages
                                </div>
                            )}
                            {received
                                .slice()
                                .reverse()
                                .map((message) => (
                                    <article
                                        className="websocket-received-row"
                                        key={message.rowId}
                                    >
                                        <div>
                                            <strong>
                                                {message.transport} {message.topicId} / {message.typeId}
                                            </strong>
                                            <small>
                                                {formatTime(message.atEpochMs)} - peer {message.peerId}
                                            </small>
                                            <small>
                                                group {message.roomId} - lane {message.laneId} - context{' '}
                                                {message.contextId}
                                            </small>
                                        </div>
                                        <pre className="mini-json">
                                            {redactedJson(
                                                message.payload,
                                                state,
                                                authSession,
                                            )}
                                        </pre>
                                    </article>
                                ))}
                        </div>
                    </section>
                </div>
            </CollapsiblePanelSection>
            {(localError || !realBackendReady || !authSession) && (
                <div
                    className={localError ? 'workbench-error' : 'command-center-status'}
                    role="status"
                >
                    {localError ??
                        (!realBackendReady
                            ? 'RTC/Realtimes requires provider=browser-rallar.'
                            : !authSession
                            ? 'RTC/Realtimes requires a logged-in browser session.'
                            : undefined)}
                </div>
            )}
            <div className="rtc-realtime-result-grid">
                <section>
                    <div className="section-heading">
                        <h3>Last Result</h3>
                        <span>{busyAction ?? 'idle'}</span>
                    </div>
                    <pre className="mini-json">
                        {redactedJson(result ?? {}, state, authSession)}
                    </pre>
                </section>
                <section>
                    <div className="section-heading">
                        <h3>Lane Health</h3>
                        <span>
                            {Array.isArray(health) ? health.length : 0} rows
                        </span>
                    </div>
                    <pre className="mini-json">
                        {redactedJson(health ?? [], state, authSession)}
                    </pre>
                </section>
            </div>
        </section>
    );
}
