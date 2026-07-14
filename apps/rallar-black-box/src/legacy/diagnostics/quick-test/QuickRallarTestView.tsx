import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import { Metric } from '../../shared/Metric.tsx';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { formatTime } from '../../shared/time-format.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../shell/rallar-browser-status.ts';
import type {
    QuickRallarTestViewModel,
    QuickRallarTransport,
} from './quick-rallar-contracts.ts';

export function QuickRallarTestView({
    state,
    authSession,
    globalValues,
    browserStatus,
    model,
    onOpenAuth,
    onOpenRunnerMode,
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
    browserStatus: RallarBrowserStatusSummary;
    model: QuickRallarTestViewModel;
    onOpenAuth(): void;
    onOpenRunnerMode(): void;
}) {
    const {
        values,
        busyAction,
        localError,
        lastResult,
        subscription,
        receivedMessages,
        waitStatus,
        providerMode,
        realBackendReady,
        canUseDirectRallar,
        activeGroupId,
        activeTypeId,
        activeContextId,
        selectorLabel,
        payloadResult,
        updateValue,
        updateGroupId,
        createGroup,
        joinGroup,
        subscribeWs,
        unsubscribeWs,
        sendWs,
        waitForReceive,
        copyDiagnostics,
        copyRunnerRecipe,
        setupComplete,
        subscribed,
        workflowSteps,
    } = model;

    return (
        <section
            className="panel quick-rallar-test-panel"
            aria-label="Rallar Quick Test"
        >
            <div className="panel-heading">
                <h2>Quick Test</h2>
                <span
                    className={`pill ${subscription ? 'good' : realBackendReady ? 'muted' : 'warn'}`}
                >
                    {subscription
                        ? 'listening'
                        : realBackendReady
                          ? 'ready'
                          : 'real backend required'}
                </span>
            </div>
            <div className="quick-workflow-strip" aria-label="Quick Test workflow">
                {workflowSteps.map((step, index) => (
                    <div
                        className={`quick-workflow-step ${step.state}`}
                        key={step.id}
                    >
                        <span>{index + 1}</span>
                        <strong>{step.label}</strong>
                        <small>{step.detail}</small>
                    </div>
                ))}
            </div>
            <CollapsiblePanelSection
                title="Quick Test Info"
                meta={subscription ? 'listening' : waitStatus}
            >
                <div className="quick-rallar-summary-grid">
                    <Metric
                        label="Provider"
                        value={providerMode}
                        tone={realBackendReady ? 'good' : 'warn'}
                    />
                    <Metric label="API" value={globalValues.apiBaseUrl} />
                    <Metric
                        label="User"
                        value={authSession?.username ?? 'not logged in'}
                        tone={authSession ? 'good' : 'warn'}
                    />
                    <Metric
                        label="Session"
                        value={authSession?.sessionId ?? '-'}
                        tone={authSession ? 'good' : 'muted'}
                    />
                    <Metric
                        label="Group"
                        value={activeGroupId || '-'}
                        tone={activeGroupId ? 'good' : 'warn'}
                    />
                    <Metric
                        label="Signal WS"
                        value={browserStatus.signalingLabel}
                        tone={browserStatus.signalingTone}
                    />
                    <Metric
                        label="Subscription"
                        value={subscription?.label ?? 'not listening'}
                        tone={subscription ? 'good' : 'muted'}
                    />
                    <Metric
                        label="Received"
                        value={String(receivedMessages.length)}
                    />
                    <Metric label="Wait" value={waitStatus} />
                    <Metric
                        label="Last action"
                        value={lastResult?.status ?? '-'}
                    />
                </div>
                <div
                    className="quick-rallar-route-grid"
                    aria-label="Quick Test route"
                >
                    <div>
                        <span>Destination</span>
                        <strong>
                            {activeGroupId
                                ? `Group ${activeGroupId}`
                                : 'No group selected'}
                        </strong>
                        <small>
                            {globalValues.applicationId || '-'} /{' '}
                            {globalValues.workspaceId || '-'}
                        </small>
                    </div>
                    <div>
                        <span>Selector</span>
                        <strong>{selectorLabel}</strong>
                        <small>Context {activeContextId}</small>
                    </div>
                    <div>
                        <span>Receive</span>
                        <strong>
                            {subscription ? 'Subscribed' : 'Not subscribed'}
                        </strong>
                        <small>
                            {subscription
                                ? formatTime(subscription.subscribedAtEpochMs)
                                : 'Subscribe WS before receiving'}
                        </small>
                    </div>
                </div>
            </CollapsiblePanelSection>
            <CollapsiblePanelSection
                title="Quick Test Inputs"
                meta={`${activeGroupId || '-'} / ${selectorLabel}`}
            >
                <div className="quick-rallar-context-grid">
                    <label className="field">
                        <span>Group</span>
                        <input
                            value={globalValues.roomId}
                            onChange={(event) =>
                                updateGroupId(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Transport</span>
                        <select
                            value={values.transport}
                            onChange={(event) =>
                                updateValue(
                                    'transport',
                                    event.target.value as QuickRallarTransport,
                                )
                            }
                        >
                            <option value="ws">WS group message</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Type ID</span>
                        <input
                            value={values.typeId}
                            onChange={(event) =>
                                updateValue('typeId', event.target.value)
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
                        />
                    </label>
                    <label className="field">
                        <span>Context ID</span>
                        <input
                            value={values.contextId}
                            onChange={(event) =>
                                updateValue('contextId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Resource ID</span>
                        <input
                            value={values.resourceId}
                            onChange={(event) =>
                                updateValue('resourceId', event.target.value)
                            }
                        />
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
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div className="quick-action-groups">
                <div className="quick-action-group primary" aria-label="Primary Quick Test actions">
                    {!realBackendReady && (
                        <button
                            type="button"
                            className="primary-action"
                            onClick={onOpenRunnerMode}
                        >
                            Open runner mode
                        </button>
                    )}
                    {realBackendReady && !authSession && (
                        <button
                            type="button"
                            className="primary-action"
                            onClick={onOpenAuth}
                        >
                            Open Auth
                        </button>
                    )}
                    {canUseDirectRallar && !subscribed && (
                        <button
                            type="button"
                            className="primary-action"
                            disabled={!activeGroupId}
                            onClick={() => void createGroup()}
                        >
                            Create and join group
                        </button>
                    )}
                    {canUseDirectRallar && !subscribed && (
                        <button
                            type="button"
                            className="primary-action"
                            disabled={!activeGroupId || !activeTypeId}
                            onClick={() => void subscribeWs()}
                        >
                            Subscribe WS
                        </button>
                    )}
                    {canUseDirectRallar && (
                        <button
                            type="button"
                            className="primary-action"
                            disabled={
                                !setupComplete ||
                                !activeTypeId ||
                                !payloadResult.ok
                            }
                            onClick={() => void sendWs()}
                        >
                            Send WS JSON
                        </button>
                    )}
                    {subscribed && (
                        <button
                            type="button"
                            className="primary-action"
                            disabled={Boolean(busyAction)}
                            onClick={() => void waitForReceive()}
                        >
                            Wait for receive
                        </button>
                    )}
                </div>
                <div className="quick-action-group secondary" aria-label="Secondary Quick Test actions">
                    <button
                        type="button"
                        className="secondary-action"
                        disabled={!canUseDirectRallar || !activeGroupId}
                        onClick={() => void joinGroup()}
                    >
                        Join group
                    </button>
                    <button
                        type="button"
                        className="secondary-action"
                        disabled={!subscription}
                        onClick={unsubscribeWs}
                    >
                        Unsubscribe WS
                    </button>
                    <button
                        type="button"
                        className="secondary-action"
                        onClick={copyDiagnostics}
                    >
                        Copy diagnostics
                    </button>
                    <button
                        type="button"
                        className="secondary-action"
                        onClick={copyRunnerRecipe}
                    >
                        Copy runner recipe
                    </button>
                    {realBackendReady && (
                        <button
                            type="button"
                            className="secondary-action"
                            onClick={onOpenRunnerMode}
                        >
                            Open runner mode
                        </button>
                    )}
                </div>
            </div>
            <CollapsiblePanelSection
                title="Quick Test Payload"
                meta={`${receivedMessages.length} received`}
            >
                <div className="quick-rallar-payload-grid">
                    <label className="json-editor">
                        <span>Payload JSON</span>
                        <textarea
                            value={values.payloadText}
                            onChange={(event) =>
                                updateValue('payloadText', event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                    <div
                        className="quick-rallar-received-panel"
                        aria-label="Quick Test received messages"
                    >
                        <div className="websocket-received-heading">
                            <div>
                                <h3>Received Messages</h3>
                                <p>
                                    {subscription
                                        ? `Listening to ${subscription.label} in ${subscription.groupId}.`
                                        : 'Not listening.'}
                                </p>
                            </div>
                            <span
                                className={`pill ${subscription ? 'good' : 'muted'}`}
                            >
                                {subscription ? 'listening' : 'idle'}
                            </span>
                        </div>
                        <div className="websocket-received-list">
                            {receivedMessages.length === 0 && (
                                <div className="empty-state">
                                    No received messages
                                </div>
                            )}
                            {receivedMessages
                                .slice()
                                .reverse()
                                .map((message) => (
                                    <article
                                        className="websocket-received-row"
                                        key={message.rowId}
                                    >
                                        <div>
                                            <strong>
                                                {message.topicId} /{' '}
                                                {message.typeId}
                                            </strong>
                                            <small>
                                                {formatTime(message.atEpochMs)}{' '}
                                                - group {message.roomId}
                                            </small>
                                            <small>
                                                sender {message.senderId} -
                                                context {message.contextId}
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
                    </div>
                </div>
            </CollapsiblePanelSection>
            {(!realBackendReady ||
                !authSession ||
                localError ||
                !payloadResult.ok ||
                busyAction) && (
                <div
                    className={
                        localError || !payloadResult.ok
                            ? 'workbench-error'
                            : 'command-center-status'
                    }
                    role="status"
                >
                    {localError ??
                        (!payloadResult.ok
                            ? payloadResult.error
                            : !realBackendReady
                              ? 'Quick Test requires provider=browser-rallar.'
                              : !authSession
                                ? 'Quick Test requires a logged-in browser session.'
                                : busyAction)}
                </div>
            )}
        </section>
    );
}
