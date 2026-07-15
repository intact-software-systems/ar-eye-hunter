import type { AuthSession } from '@shared/api/api-config.ts';
import type { ControlRunSnapshot } from '../../../control-run-manager.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';

export function RunnerAgentSetupPanel({
    runId,
    agentPrefix,
    agentCount,
    restoreSession,
    providerMode,
    authSession,
    controlWsUrl,
    groupId,
    connectedAgents,
    agentIds,
    launchMessage,
    showConnectedAgents = true,
    onRunIdChange,
    onAgentPrefixChange,
    onAgentCountChange,
    onRestoreSessionChange,
    onOpenAgents,
    onCopyLinks,
}: {
    runId: string;
    agentPrefix: string;
    agentCount: number;
    restoreSession: boolean;
    providerMode: RallarBlackBoxBootstrapConfig['providerMode'];
    authSession?: AuthSession;
    controlWsUrl: string;
    groupId: string;
    connectedAgents: ControlRunSnapshot['agents'];
    agentIds: readonly string[];
    launchMessage?: string;
    showConnectedAgents?: boolean;
    onRunIdChange(value: string): void;
    onAgentPrefixChange(value: string): void;
    onAgentCountChange(value: number): void;
    onRestoreSessionChange(value: boolean): void;
    onOpenAgents(): void;
    onCopyLinks(): void;
}) {
    const canOpenAgents =
        runId.trim().length > 0 &&
        groupId.trim().length > 0 &&
        agentPrefix.trim().length > 0 &&
        agentIds.length > 0;
    const activeAgents = connectedAgents.filter((agent) => agent.connected);

    return (
        <section className="runner-agent-setup" aria-label="Connect Agents">
            <div className="section-heading">
                <div>
                    <h3>Connect Agents</h3>
                    <p>
                        {activeAgents.length > 0
                            ? `${activeAgents.length} connected.`
                            : 'No agents connected.'}
                    </p>
                </div>
                <span className={`pill ${activeAgents.length > 0 ? 'good' : 'bad'}`}>
                    {activeAgents.length}/{connectedAgents.length}
                </span>
            </div>
            <div className="runner-agent-grid">
                <label className="field">
                    <span>Run ID</span>
                    <input
                        value={runId}
                        onChange={(event) => onRunIdChange(event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Agent Prefix</span>
                    <input
                        value={agentPrefix}
                        onChange={(event) =>
                            onAgentPrefixChange(event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Agent Tabs</span>
                    <input
                        min={1}
                        max={6}
                        type="number"
                        value={agentCount}
                        onChange={(event) =>
                            onAgentCountChange(
                                Math.min(
                                    6,
                                    Math.max(1, Number(event.target.value) || 1),
                                ),
                            )
                        }
                    />
                </label>
                <label className="toggle-field runner-agent-restore">
                    <input
                        type="checkbox"
                        checked={restoreSession}
                        onChange={(event) =>
                            onRestoreSessionChange(event.target.checked)
                        }
                    />
                    <span>Mint fresh per-tab sessions from current login</span>
                </label>
            </div>
            <div className="runner-agent-actions">
                <button
                    type="button"
                    disabled={!canOpenAgents}
                    title={
                        canOpenAgents
                            ? undefined
                            : 'Set run ID, group, and agent prefix first.'
                    }
                    onClick={onOpenAgents}
                >
                    Open agent tabs
                </button>
                <button
                    type="button"
                    disabled={!canOpenAgents}
                    onClick={onCopyLinks}
                >
                    Copy agent links
                </button>
            </div>
            <div className="runner-agent-preview" aria-label="Agent IDs">
                <strong>Next agent IDs</strong>
                <span>
                    {agentIds.join(', ')}
                </span>
            </div>
            <dl className="config-list runner-agent-meta">
                <div>
                    <dt>Control WS</dt>
                    <dd>{controlWsUrl}</dd>
                </div>
                <div>
                    <dt>Group</dt>
                    <dd>{groupId || 'missing'}</dd>
                </div>
                <div>
                    <dt>Provider</dt>
                    <dd>{providerMode}</dd>
                </div>
                <div>
                    <dt>Login</dt>
                    <dd>
                        {authSession
                            ? `${authSession.username} fresh per-tab sessions`
                            : restoreSession
                              ? 'fresh per-tab sessions requested'
                              : 'agent signs in'}
                    </dd>
                </div>
            </dl>
            {showConnectedAgents && activeAgents.length > 0 ? (
                <div className="runner-agent-list" aria-label="Connected agents">
                    {activeAgents.map((agent) => (
                        <article
                            className="runner-agent-row"
                            key={agent.agentId}
                        >
                            <span>
                                <strong>{agent.agentId}</strong>
                                <small>
                                    {agent.identity?.principalId ??
                                        agent.identity?.sessionId ??
                                        'no identity'}
                                </small>
                            </span>
                            <span
                                className={`pill ${agent.connected ? 'good' : 'bad'}`}
                            >
                                {agent.connected ? 'connected' : 'offline'}
                            </span>
                        </article>
                    ))}
                </div>
            ) : showConnectedAgents ? (
                <div className="empty-state">
                    Open an agent tab with a one-time link, then Refresh.
                </div>
            ) : undefined}
            {showConnectedAgents && connectedAgents.length > activeAgents.length && (
                <small className="runner-agent-offline-note">
                    {connectedAgents.length - activeAgents.length} offline agent{connectedAgents.length - activeAgents.length === 1 ? '' : 's'} hidden
                </small>
            )}
            {launchMessage && (
                <div className="command-center-status" role="status">
                    {launchMessage}
                </div>
            )}
        </section>
    );
}
