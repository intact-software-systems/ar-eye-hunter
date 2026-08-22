import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import { Metric } from '../../shared/Metric.tsx';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import { formatDuration, formatTime } from '../../shared/time-format.ts';
import { CommandCenterActionFeedbackPanel } from '../shared/CommandCenterActionFeedbackPanel.tsx';
import {
    CLIENT_SORT_OPTIONS,
    GROUP_SORT_OPTIONS,
    ROOMS_CLIENTS_ACTION_GROUPS,
    type ClientSortId,
    type GroupSortId
} from './rooms-clients-contracts.ts';
import type { RoomsClientsControllerModel } from './use-rooms-clients-controller.ts';

export function RoomsClientsView({
    state,
    bootstrap,
    authSession,
    model
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    model: RoomsClientsControllerModel;
}) {
    const {
        apiBaseUrl,
        setApiBaseUrl,
        variables,
        timeoutMs,
        setTimeoutMs,
        busyAction,
        localError,
        actionFeedback,
        actions,
        onlyGroupsWithMembers,
        setOnlyGroupsWithMembers,
        onlyOnlineClients,
        setOnlyOnlineClients,
        groupSort,
        setGroupSort,
        clientSort,
        setClientSort,
        expectedOtherClient,
        setExpectedOtherClient,
        updateVariable,
        runPresetAction,
        refreshState,
        runDirectRoomsAction,
        copyStateRecipe,
        groupRows,
        clientRows,
        visibleGroupRows,
        visibleClientRows,
        sortedGroupRows,
        sortedClientRows,
        stateEvents,
        expectedClients,
        observedClients,
        missingClients,
        currentSessionInGroup,
        currentClientOnline,
        expectedOtherClientVisible
    } = model;

    return (
        <section className="panel rooms-clients-panel">
            <div className="panel-heading">
                <h2>Groups/Clients</h2>
                <span className={`pill ${authSession ? 'good' : 'bad'}`}>
                    {authSession ? 'auth attached' : 'needs auth'}
                </span>
            </div>
            <CollapsiblePanelSection
                title="Groups/Clients Inputs"
                meta={`${variables.groupId || '-'} / ${variables.principalId || '-'}`}
            >
                <div className="rooms-context-grid">
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={apiBaseUrl}
                            onChange={(event) => setApiBaseUrl(event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Application</span>
                        <input
                            value={variables.applicationId}
                            onChange={(event) =>
                                updateVariable(
                                    'applicationId',
                                    event.target.value
                                )}
                        />
                    </label>
                    <label className="field">
                        <span>Workspace</span>
                        <input
                            value={variables.workspaceId}
                            onChange={(event) =>
                                updateVariable(
                                    'workspaceId',
                                    event.target.value
                                )}
                        />
                    </label>
                    <label className="field">
                        <span>Group</span>
                        <input
                            value={variables.groupId}
                            onChange={(event) => updateVariable('groupId', event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Principal / Client</span>
                        <input
                            value={variables.principalId}
                            onChange={(event) =>
                                updateVariable(
                                    'principalId',
                                    event.target.value
                                )}
                        />
                    </label>
                    <label className="field">
                        <span>Instance</span>
                        <input
                            value={variables.clientInstanceId}
                            onChange={(event) =>
                                updateVariable(
                                    'clientInstanceId',
                                    event.target.value
                                )}
                        />
                    </label>
                    <label className="field">
                        <span>Session</span>
                        <input
                            value={variables.sessionId}
                            onChange={(event) => updateVariable('sessionId', event.target.value)}
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
                </div>
            </CollapsiblePanelSection>
            <div className="rooms-utility-grid">
                <button
                    type="button"
                    disabled={Boolean(busyAction) || !authSession}
                    onClick={() => void refreshState()}
                >
                    Refresh state
                </button>
                <button type="button" onClick={copyStateRecipe}>
                    Copy state recipe
                </button>
            </div>
            <CommandCenterActionFeedbackPanel
                feedback={actionFeedback}
                state={state}
                authSession={authSession}
            />
            <div
                className="rooms-action-sections"
                aria-label="Groups and clients actions"
            >
                {ROOMS_CLIENTS_ACTION_GROUPS.map((category) => (
                    <section
                        key={category.categoryId}
                        className="rooms-action-category"
                        aria-label={`${category.title}. ${category.description}`}
                    >
                        <h3>{category.title}</h3>
                        {category.categoryId === 'groups'
                            ? (
                                <div className="rooms-action-subsection">
                                    <h4>Rallar facade</h4>
                                    <div className="rooms-action-grid">
                                        <button
                                            type="button"
                                            disabled={Boolean(busyAction) ||
                                                !authSession ||
                                                bootstrap.providerMode !==
                                                    'browser-rallar'}
                                            onClick={() => void runDirectRoomsAction('refresh')}
                                        >
                                            Rallar refresh
                                        </button>
                                        <button
                                            type="button"
                                            disabled={Boolean(busyAction) ||
                                                !authSession ||
                                                bootstrap.providerMode !==
                                                    'browser-rallar'}
                                            onClick={() => void runDirectRoomsAction('create')}
                                        >
                                            Rallar create group
                                        </button>
                                        <button
                                            type="button"
                                            disabled={Boolean(busyAction) ||
                                                !authSession ||
                                                bootstrap.providerMode !==
                                                    'browser-rallar'}
                                            onClick={() => void runDirectRoomsAction('join')}
                                        >
                                            Rallar join group
                                        </button>
                                        <button
                                            type="button"
                                            disabled={Boolean(busyAction) ||
                                                !authSession ||
                                                bootstrap.providerMode !==
                                                    'browser-rallar'}
                                            onClick={() => void runDirectRoomsAction('leave')}
                                        >
                                            Rallar leave group
                                        </button>
                                    </div>
                                </div>
                            )
                            : null}
                        <div className="rooms-action-subsection">
                            <h4>Rallar Server REST</h4>
                            <div className="rooms-action-grid">
                                {category.actions.map((action) => (
                                    <button
                                        key={action.actionId}
                                        type="button"
                                        disabled={Boolean(busyAction) || !authSession}
                                        onClick={() => void runPresetAction(action)}
                                    >
                                        {action.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </section>
                ))}
            </div>
            <div
                className="rooms-filter-row"
                aria-label="Groups and clients filters"
            >
                <label className="check-field">
                    <input
                        type="checkbox"
                        checked={onlyGroupsWithMembers}
                        onChange={(event) => setOnlyGroupsWithMembers(event.target.checked)}
                    />
                    <span>Groups with members</span>
                </label>
                <label className="check-field">
                    <input
                        type="checkbox"
                        checked={onlyOnlineClients}
                        onChange={(event) => setOnlyOnlineClients(event.target.checked)}
                    />
                    <span>Online clients</span>
                </label>
                <span className="filter-summary">
                    {visibleGroupRows.length}/{groupRows.length} groups, {visibleClientRows.length}/{clientRows.length}
                    {' '}
                    clients
                </span>
                <label className="field compact-field rooms-sort-field">
                    <span>Group sort</span>
                    <select
                        aria-label="Group sort"
                        value={groupSort}
                        onChange={(event) => setGroupSort(event.target.value as GroupSortId)}
                    >
                        {GROUP_SORT_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field compact-field rooms-sort-field">
                    <span>Client sort</span>
                    <select
                        aria-label="Client sort"
                        value={clientSort}
                        onChange={(event) => setClientSort(event.target.value as ClientSortId)}
                    >
                        {CLIENT_SORT_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field compact-field rooms-sort-field">
                    <span>Expected other client</span>
                    <input
                        aria-label="Expected other client"
                        value={expectedOtherClient}
                        onChange={(event) => setExpectedOtherClient(event.target.value)}
                    />
                </label>
            </div>
            {localError && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        localError,
                        uiRedactionOptions(state, authSession)
                    )}
                </div>
            )}
            <div className="rooms-observed-grid">
                <Metric
                    label="Expected clients"
                    value={String(expectedClients.length)}
                />
                <Metric
                    label="Observed clients"
                    value={String(observedClients.length)}
                    tone={missingClients.length ? 'warn' : 'good'}
                />
                <Metric
                    label="Missing clients"
                    value={String(missingClients.length)}
                    tone={missingClients.length ? 'bad' : 'good'}
                />
                <Metric
                    label="Group rows"
                    value={String(visibleGroupRows.length)}
                />
                <Metric
                    label="Client rows"
                    value={String(visibleClientRows.length)}
                />
                <Metric label="Events" value={String(stateEvents.length)} />
                <Metric
                    label="Current client member"
                    value={currentClientOnline ? 'yes' : 'no'}
                    tone={currentClientOnline ? 'good' : 'warn'}
                />
                <Metric
                    label="Other browser visible"
                    value={expectedOtherClientVisible ? 'yes' : 'no'}
                    tone={expectedOtherClientVisible ? 'good' : 'warn'}
                />
            </div>
            <div className="rooms-state-grid">
                <section className="rooms-subpanel">
                    <div className="section-heading">
                        <h3>Groups</h3>
                        <span>{visibleGroupRows.length} rows</span>
                    </div>
                    <div className="state-table">
                        {visibleGroupRows.length === 0 && (
                            <div className="empty-state">
                                {groupRows.length === 0
                                    ? 'No group state loaded'
                                    : 'No groups match filters'}
                            </div>
                        )}
                        {sortedGroupRows.map((row) => (
                            <article
                                className="state-table-row"
                                key={row.rowId}
                            >
                                <div>
                                    <strong>{row.displayName}</strong>
                                    <small>{row.groupId}</small>
                                </div>
                                <span>{row.status}</span>
                                <span>{row.members} members</span>
                                <span>{row.online} online</span>
                                <small>
                                    {row.sessions.join(', ') || '-'}
                                    {' - active '}
                                    {formatTime(row.activeAtEpochMs)}
                                </small>
                            </article>
                        ))}
                    </div>
                </section>
                <section className="rooms-subpanel">
                    <div className="section-heading">
                        <h3>Clients</h3>
                        <span>{visibleClientRows.length} rows</span>
                    </div>
                    <div className="state-table">
                        {visibleClientRows.length === 0 && (
                            <div className="empty-state">
                                {clientRows.length === 0
                                    ? 'No client state loaded'
                                    : 'No clients match filters'}
                            </div>
                        )}
                        {sortedClientRows.map((row) => (
                            <article
                                className="state-table-row"
                                key={row.rowId}
                            >
                                <div>
                                    <strong>{row.username}</strong>
                                    <small>{row.principalId}</small>
                                </div>
                                <span>{row.status}</span>
                                <span>{row.online}</span>
                                <span>{row.sessions.length} sessions</span>
                                <small>
                                    {row.sessions.join(', ') || '-'}
                                    {' - active '}
                                    {formatTime(row.activeAtEpochMs)}
                                </small>
                            </article>
                        ))}
                    </div>
                </section>
                <section className="rooms-subpanel rooms-events-panel">
                    <div className="section-heading">
                        <h3>State Events</h3>
                        <span>{stateEvents.length} rows</span>
                    </div>
                    <div className="state-table">
                        {stateEvents.length === 0 && (
                            <div className="empty-state">
                                No state events loaded
                            </div>
                        )}
                        {stateEvents.map((row) => (
                            <article
                                className="state-table-row"
                                key={row.rowId}
                            >
                                <div>
                                    <strong>{row.eventType}</strong>
                                    <small>{row.rowId}</small>
                                </div>
                                <span>{row.subject}</span>
                                <span>v{row.snapshotVersion}</span>
                                <span>{formatTime(row.atEpochMs)}</span>
                            </article>
                        ))}
                    </div>
                </section>
                <section className="rooms-subpanel">
                    <div className="section-heading">
                        <h3>Actions</h3>
                        <span>{actions.length} recent</span>
                    </div>
                    <div className="command-center-action-list">
                        {actions.length === 0 && (
                            <div className="empty-state">
                                No state actions yet
                            </div>
                        )}
                        {actions
                            .slice()
                            .reverse()
                            .map((action) => (
                                <article
                                    className="command-center-action-row"
                                    key={action.actionId}
                                >
                                    <div>
                                        <strong>{action.label}</strong>
                                        <small>
                                            {formatTime(action.atEpochMs)} - {formatDuration(action.durationMs)}
                                        </small>
                                    </div>
                                    <span
                                        className={`pill ${action.ok ? 'good' : 'bad'}`}
                                    >
                                        {action.status ||
                                            action.errorKind ||
                                            'local'}
                                    </span>
                                </article>
                            ))}
                    </div>
                </section>
            </div>
        </section>
    );
}
