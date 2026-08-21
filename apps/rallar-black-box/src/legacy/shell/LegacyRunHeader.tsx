import {
    selectRallarBlackBoxActiveCommand,
    selectRallarBlackBoxCurrentConfig,
    selectRallarBlackBoxFirstFailure,
    selectRallarBlackBoxLatestStats
} from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useState } from 'react';
import type { AppModeId } from '../../app-tabs.ts';
import type { RallarBlackBoxControlSnapshot } from '../../control-client.ts';
import {
    rallarBlackBoxProviderModeFromConfig,
    rallarBlackBoxRuntimeStore,
    type RallarBlackBoxBootstrapConfig
} from '../../runtime-store.ts';
import { statusTone } from '../shared/command-presentation.ts';
import { Metric } from '../shared/Metric.tsx';
import type { CommandCenterGlobalValues } from './global-context-model.ts';
import type { RallarBrowserStatusSummary } from './rallar-browser-status.ts';

export function Header({
    mode,
    state,
    control,
    bootstrap,
    globalValues,
    browserStatus,
    bootstrapping,
    lastAction,
    authSession,
    authBusy,
    onLogout
}: {
    mode: AppModeId;
    state: RallarBlackBoxTestState;
    control: RallarBlackBoxControlSnapshot;
    bootstrap: RallarBlackBoxBootstrapConfig;
    globalValues: CommandCenterGlobalValues;
    browserStatus: RallarBrowserStatusSummary;
    bootstrapping: boolean;
    lastAction?: string;
    authSession?: AuthSession;
    authBusy: boolean;
    onLogout(): void;
}) {
    const [detailsExpanded, setDetailsExpanded] = useState(false);
    const config = selectRallarBlackBoxCurrentConfig(state);
    const stats = selectRallarBlackBoxLatestStats(state);
    const activeCommand = selectRallarBlackBoxActiveCommand(state);
    const firstFailure = selectRallarBlackBoxFirstFailure(state);
    const providerMode = config
        ? rallarBlackBoxProviderModeFromConfig(config)
        : bootstrap.providerMode;
    const rallarValue = providerMode === 'simulated'
        ? 'simulated'
        : browserStatus.rallarConnected || stats?.rallar?.connected
        ? 'connected'
        : 'not connected';
    const effectiveRoom = globalValues.roomId ||
        config?.roomId ||
        bootstrap.roomId ||
        'not joined';
    const effectiveUser = authSession?.username ??
        authSession?.clientId ??
        globalValues.clientId ??
        config?.actor ??
        bootstrap.actor ??
        'none';
    const effectiveSession = authSession?.sessionId ??
        globalValues.sessionId ??
        config?.sessionId ??
        bootstrap.sessionId ??
        'none';

    return (
        <header
            className={`run-header ${detailsExpanded ? 'expanded' : 'collapsed'}`}
        >
            <div className="run-title">
                <p className="eyebrow">Rallar Kit</p>
                <h1>{config?.runId ?? bootstrap.runId ?? 'No run loaded'}</h1>
                <button
                    type="button"
                    className="header-toggle"
                    aria-expanded={detailsExpanded}
                    aria-controls="run-header-details run-header-actions"
                    onClick={() => setDetailsExpanded((current) => !current)}
                >
                    {detailsExpanded ? 'Hide details' : 'Show details'}
                </button>
            </div>
            <div
                className="header-grid header-grid--summary"
                aria-label="Run state"
            >
                <Metric
                    label="Provider"
                    value={providerMode}
                    tone={providerMode === 'simulated' ? 'warn' : 'active'}
                />
                <Metric
                    label="Control"
                    value={control.state}
                    tone={statusTone(control.state)}
                />
                <Metric
                    label="Rallar"
                    value={rallarValue}
                    tone={browserStatus.rallarConnected ||
                            stats?.rallar?.connected
                        ? 'good'
                        : providerMode === 'simulated'
                        ? 'warn'
                        : 'muted'}
                />
                <Metric label="Room" value={effectiveRoom} />
                <Metric
                    label="Failure"
                    value={firstFailure?.commandId ?? 'none'}
                    tone={firstFailure ? 'bad' : 'good'}
                />
            </div>
            <div
                className="header-actions"
                id="run-header-actions"
                hidden={!detailsExpanded}
            >
                <span className={`pill ${bootstrapping ? 'active' : 'good'}`}>
                    {bootstrapping ? 'running' : 'ready'}
                </span>
                <span className="last-action">
                    {lastAction ?? 'Waiting for runtime events'}
                </span>
                {mode === 'black-box-runner' && (
                    <button
                        type="button"
                        onClick={() => void rallarBlackBoxRuntimeStore.runSample()}
                        disabled={bootstrapping || providerMode === 'browser-rallar'}
                    >
                        Replay Sample
                    </button>
                )}
                {authSession && (
                    <button
                        type="button"
                        className="header-logout-button"
                        onClick={onLogout}
                        disabled={authBusy}
                    >
                        {authBusy ? 'Signing out' : 'Logout'}
                    </button>
                )}
            </div>
            <div
                className="header-grid header-grid--details"
                id="run-header-details"
                aria-label="Run details"
                hidden={!detailsExpanded}
            >
                <Metric
                    label="Agent"
                    value={config?.agentId ?? bootstrap.agentId ?? 'unassigned'}
                />
                <Metric label="Protocol" value="1" />
                <Metric
                    label="Runtime"
                    value={state.status}
                    tone={statusTone(state.status)}
                />
                <Metric
                    label="Signal WS"
                    value={browserStatus.signalingLabel}
                    tone={browserStatus.signalingTone}
                />
                <Metric
                    label="RTC"
                    value={browserStatus.rtcLabel}
                    tone={browserStatus.rtcTone}
                />
                <Metric
                    label="Environment"
                    value={config?.environment ?? bootstrap.environment ?? 'local'}
                />
                <Metric label="User" value={effectiveUser} />
                <Metric label="Session" value={effectiveSession} />
                <Metric
                    label="Active"
                    value={activeCommand?.commandId ?? 'none'}
                    tone={activeCommand ? 'active' : 'muted'}
                />
            </div>
        </header>
    );
}
