import type { ExecuteAgentLaunchModel } from './use-execute-agent-launch.ts';
import type { RecipeConsoleControlConnection } from
    '../control/ControlConnectionProvider.tsx';
import { useRef } from 'react';
import styles from './ExecuteAgentSetup.module.css';

export function ExecuteAgentSetup({
    connection,
    model,
}: Readonly<{
    connection: RecipeConsoleControlConnection;
    model: ExecuteAgentLaunchModel;
}>) {
    const copyLinksRef = useRef<HTMLButtonElement>(null);
    const group = model.group;
    const noun = model.count === 1 ? 'browser agent' : 'browser agents';
    const displacedBlockedAgentIds = model.blockedAgentIds.filter(
        agentId => !model.agentIds.includes(agentId),
    );
    return (
        <section className={styles.setup} data-execute-agent-setup>
            <header className={styles.header}>
                <div>
                    <p>Local control-agent pages</p>
                    <h3>Browser agents</h3>
                </div>
                <button
                    aria-controls="execute-agent-setup-body"
                    aria-expanded={model.expanded}
                    onClick={() => model.setExpanded(!model.expanded)}
                    type="button"
                >{model.expanded ? 'Hide browser agent setup' : 'Add browser agents'}</button>
            </header>
            {model.expanded ? (
                <div className={styles.body} id="execute-agent-setup-body">
                    <div className={styles.fields}>
                        <label>
                            <span>Control run ID for new agents</span>
                            <input
                                disabled={model.busyAction !== undefined}
                                onChange={event => model.setRunId(event.target.value)}
                                spellCheck={false}
                                value={model.runId}
                            />
                        </label>
                        <label>
                            <span>Agent ID prefix</span>
                            <input
                                disabled={model.busyAction !== undefined}
                                onChange={event => model.setPrefix(event.target.value)}
                                spellCheck={false}
                                value={model.prefix}
                            />
                        </label>
                        <label>
                            <span>Agent count</span>
                            <input
                                disabled={model.busyAction !== undefined}
                                inputMode="numeric"
                                max={6}
                                min={1}
                                onChange={event => model.setCount(Number(event.target.value))}
                                type="number"
                                value={model.count}
                            />
                        </label>
                    </div>
                    <dl className={styles.context}>
                        <Fact label="Provider" value={connection.bootstrap.providerMode} />
                        <Fact label="Control origin" value={connection.baseUrl} />
                        <Fact label="API origin" value={connection.bootstrap.apiBaseUrl} />
                        <Fact label="Group" value={`${group.applicationId} / ${group.workspaceId} / ${group.groupId}`} />
                    </dl>
                    {model.blocker ? (
                        <p className={styles.blocker} role="alert">{model.blocker}</p>
                    ) : null}
                    <div className={styles.actions}>
                        <button
                            className={styles.primary}
                            disabled={Boolean(model.blocker || model.busyAction)}
                            onClick={() => {
                                if (model.openAgents() === 'blocked') {
                                    copyLinksRef.current?.focus();
                                }
                            }}
                            type="button"
                        >{model.busyAction === 'open'
                            ? `Opening ${noun}…`
                            : `Open ${model.count} ${noun}`}</button>
                        <button
                            disabled={Boolean(model.blocker || model.busyAction)}
                            onClick={() => void model.copyAgentLinks()}
                            ref={copyLinksRef}
                            type="button"
                        >{model.busyAction === 'copy'
                            ? 'Preparing links…'
                            : `Copy ${model.count} launch ${model.count === 1 ? 'link' : 'links'}`}</button>
                    </div>
                    <div
                        aria-label="Individual browser-agent launch links"
                        className={styles.linkList}
                        role="group"
                    >
                        <strong>Individual launch links</strong>
                        {model.agentIds.map(agentId => (
                            <div className={styles.linkRow} key={agentId}>
                                <code>{agentId}</code>
                                {model.blockedAgentIds.includes(agentId) ? (
                                    <span>Popup blocked</span>
                                ) : null}
                                <button
                                    disabled={Boolean(model.blocker || model.busyAction)}
                                    onClick={() => void model.copyAgentLink(agentId)}
                                    type="button"
                                >Copy link for {agentId}</button>
                            </div>
                        ))}
                    </div>
                    {displacedBlockedAgentIds.length > 0 ? (
                        <div
                            aria-label="Popup-blocked browser-agent launch links"
                            className={styles.linkList}
                            role="group"
                        >
                            <strong>Popup-blocked launch links</strong>
                            {displacedBlockedAgentIds.map(agentId => (
                                <div className={styles.linkRow} key={agentId}>
                                    <code>{agentId}</code>
                                    <span>Popup blocked</span>
                                    <button
                                        disabled={Boolean(model.blocker || model.busyAction)}
                                        onClick={() => void model.copyAgentLink(agentId)}
                                        type="button"
                                    >Copy link for {agentId}</button>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    <p aria-live="polite" className={styles.status} role="status">
                        {model.message ?? (
                            model.launchedExpectedCount > 0
                                ? `${model.launchedReadyCount} of ${model.launchedExpectedCount} launched agents ready.`
                                : 'Launch links are minted only when you open or copy them.'
                        )}
                    </p>
                </div>
            ) : null}
        </section>
    );
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
    return <div><dt>{label}</dt><dd><code>{value}</code></dd></div>;
}
