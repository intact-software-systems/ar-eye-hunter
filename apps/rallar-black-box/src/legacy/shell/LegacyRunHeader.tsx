import {
    decodeRallarBlackBoxConfigProviderMode,
    type RallarBlackBoxProviderMode
} from '@shared-test/rallar-bb-test/client-defaults.ts';
import type { RallarBlackBoxControlSnapshot } from '@shared-test/rallar-bb-test/control-client.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    getRallarBlackBoxActiveCommand,
    getRallarBlackBoxCurrentConfig,
    getRallarBlackBoxFirstFailure,
    getRallarBlackBoxLatestStats
} from '@shared-test/rallar-bb-test/test-state-accessors.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import { useState } from 'react';
import type { AppModeId } from '../../app-tabs.ts';
import { rallarBlackBoxRuntimeStore, type RallarBlackBoxBootstrapConfig } from '../../runtime-store.ts';
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
    const config = getRallarBlackBoxCurrentConfig(state);
    const stats = getRallarBlackBoxLatestStats(state);
    const activeCommand = getRallarBlackBoxActiveCommand(state);
    const firstFailure = getRallarBlackBoxFirstFailure(state);
    const configuredProviderMode = config === undefined
        ? Either.ofRight<string, RallarBlackBoxProviderMode>(bootstrap.providerMode)
        : decodeRallarBlackBoxConfigProviderMode(config);
    const providerMode = configuredProviderMode.fold(() => 'unreadable', (mode) => mode);
    const providerTone = configuredProviderMode.fold(() => 'bad', (mode) => mode === 'simulated' ? 'warn' : 'active');
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
                    tone={providerTone}
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
