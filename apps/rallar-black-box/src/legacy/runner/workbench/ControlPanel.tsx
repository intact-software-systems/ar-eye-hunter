import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { useEffect, useState } from 'react';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { statusTone } from '../../shared/command-presentation.ts';
import { formatTime } from '../../shared/time-format.ts';

export function ControlPanel({
    state,
    control
}: {
    state: RallarBlackBoxTestState;
    control: RallarBlackBoxControlSnapshot;
}) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const [url, setUrl] = useState(control.url ?? '');
    const [runId, setRunId] = useState(control.runId ?? config?.runId ?? '');
    const [agentId, setAgentId] = useState(
        control.agentId ?? config?.agentId ?? ''
    );
    const connected = control.state === 'registered';
    const connecting = control.state === 'connecting' || control.state === 'reconnecting';

    useEffect(() => {
        if (!runId && config?.runId) {
            setRunId(config.runId);
        }
        if (!agentId && config?.agentId) {
            setAgentId(config.agentId);
        }
    }, [agentId, config?.agentId, config?.runId, runId]);

    useEffect(() => {
        if (control.url && url.length === 0) {
            setUrl(control.url);
        }
    }, [control.url, url.length]);

    return (
        <section className="panel control-panel">
            <div className="panel-heading">
                <h2>Control Client</h2>
                <span className={`pill ${statusTone(control.state)}`}>
                    {control.state}
                </span>
            </div>
            <div className="control-grid">
                <label className="field">
                    <span>WebSocket URL</span>
                    <input
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        disabled={connected || connecting}
                    />
                </label>
                <label className="field">
                    <span>Run ID</span>
                    <input
                        value={runId}
                        onChange={(event) => setRunId(event.target.value)}
                        disabled={connected || connecting}
                    />
                </label>
                <label className="field">
                    <span>Agent ID</span>
                    <input
                        value={agentId}
                        onChange={(event) => setAgentId(event.target.value)}
                        disabled={connected || connecting}
                    />
                </label>
            </div>
            <div className="control-actions">
                <button
                    type="button"
                    disabled={!url || connected || connecting}
                    onClick={() =>
                        rallarBlackBoxRuntimeStore.connectControl(
                            url,
                            runId,
                            agentId
                        )}
                >
                    Connect
                </button>
                <button
                    type="button"
                    disabled={control.state === 'idle' ||
                        control.state === 'disconnected'}
                    onClick={() => rallarBlackBoxRuntimeStore.disconnectControl()}
                >
                    Disconnect
                </button>
            </div>
            <dl className="control-stats">
                <div>
                    <dt>Sent</dt>
                    <dd>{control.sentCount}</dd>
                </div>
                <div>
                    <dt>Received</dt>
                    <dd>{control.receivedCount}</dd>
                </div>
                <div>
                    <dt>Reconnects</dt>
                    <dd>{control.reconnectAttempt}</dd>
                </div>
                <div>
                    <dt>Heartbeat</dt>
                    <dd>{formatTime(control.lastHeartbeatAtEpochMs)}</dd>
                </div>
            </dl>
            {control.lastError && (
                <div className="workbench-error" role="status">
                    {control.lastError}
                </div>
            )}
        </section>
    );
}
