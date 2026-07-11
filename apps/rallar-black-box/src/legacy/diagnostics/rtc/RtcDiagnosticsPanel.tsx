import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import { RtcDiagnosticsTimeseriesPanel } from '../../runner/evidence/rtc/RtcDiagnosticsTimeseriesPanel.tsx';
import { RtcPerformancePanel } from '../../runner/evidence/rtc/RtcPerformancePanel.tsx';
import { Metric } from '../../shared/Metric.tsx';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import { formatDuration } from '../../shared/time-format.ts';
import { formatList, stageTone } from './rtc-diagnostics-presentation.ts';
import {
    type UseRtcDiagnosticsControllerInput,
    useRtcDiagnosticsController,
} from './use-rtc-diagnostics-controller.ts';

export function RtcDiagnosticsPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    busy,
    onSelectCommand,
}: UseRtcDiagnosticsControllerInput) {
    const {
        diagnostics,
        rtcPerformance,
        bundleVisible,
        setBundleVisible,
        canRunDirect,
        bundleText,
        localError,
        runAction,
        copyBundle,
    } = useRtcDiagnosticsController({
        state,
        bootstrap,
        authSession,
        globalValues,
        busy,
        onSelectCommand,
    });

    return (
        <section className="panel rtc-diagnostics-panel">
            <div className="panel-heading">
                <h2>RTC Diagnostics</h2>
                <span
                    className={`pill ${diagnostics.failure ? 'bad' : 'good'}`}
                >
                    {diagnostics.failure ? 'focused' : 'clear'}
                </span>
            </div>
            <div className="rtc-actions">
                <button
                    type="button"
                    disabled={!canRunDirect}
                    onClick={() =>
                        void runAction('RTC reconnect check', 'reconnect')
                    }
                >
                    Reconnect
                </button>
                <button
                    type="button"
                    disabled={!canRunDirect}
                    onClick={() =>
                        void runAction('RTC rejoin check', 'connect')
                    }
                >
                    Rejoin
                </button>
                <button
                    type="button"
                    disabled={!canRunDirect}
                    onClick={() => void runAction('RTC health check', 'health')}
                >
                    Health
                </button>
                <button
                    type="button"
                    disabled={!canRunDirect}
                    onClick={() => void runAction('RTC close', 'close')}
                >
                    Close
                </button>
                <button
                    type="button"
                    disabled={!canRunDirect}
                    onClick={() => void runAction('RTC cleanup', 'cleanup')}
                >
                    Cleanup
                </button>
                <button type="button" onClick={copyBundle}>
                    Copy Bundle
                </button>
                <button
                    type="button"
                    onClick={() => setBundleVisible((current) => !current)}
                >
                    {bundleVisible ? 'Hide Bundle' : 'Show Bundle'}
                </button>
            </div>
            <div className="rtc-latency-grid">
                <Metric
                    label="Connect"
                    value={formatDuration(diagnostics.latency.connectMs)}
                />
                <Metric
                    label="First payload"
                    value={formatDuration(diagnostics.latency.firstPayloadMs)}
                />
                <Metric
                    label="From connect"
                    value={formatDuration(
                        diagnostics.latency.firstPayloadFromConnectMs,
                    )}
                />
                <Metric
                    label="Last command"
                    value={formatDuration(diagnostics.latency.lastCommandMs)}
                />
                <Metric
                    label="Avg command"
                    value={formatDuration(diagnostics.latency.averageCommandMs)}
                />
                <Metric
                    label="Max command"
                    value={formatDuration(diagnostics.latency.maxCommandMs)}
                />
            </div>
            <RtcPerformancePanel
                view={rtcPerformance}
                showTimeseries={false}
            />
            <RtcDiagnosticsTimeseriesPanel series={diagnostics.timeseries} />
            <div className="rtc-stage-list">
                {diagnostics.stages.map((stage) => (
                    <article className="rtc-stage-row" key={stage.stageId}>
                        <span
                            className={`status-dot ${stage.status === 'observed' ? 'completed' : stage.status}`}
                        />
                        <div>
                            <strong>{stage.label}</strong>
                            <small>
                                {stage.topic ?? 'waiting for runtime event'}
                            </small>
                        </div>
                        <span className={`pill ${stageTone(stage.status)}`}>
                            {stage.status}
                        </span>
                        <span>{formatDuration(stage.durationFromStartMs)}</span>
                    </article>
                ))}
            </div>
            <dl className="rtc-membership-list">
                <div>
                    <dt>Connection</dt>
                    <dd>{diagnostics.membership.connection}</dd>
                </div>
                <div>
                    <dt>Actor</dt>
                    <dd>{diagnostics.membership.actor}</dd>
                </div>
                <div>
                    <dt>Room</dt>
                    <dd>{diagnostics.membership.roomId}</dd>
                </div>
                <div>
                    <dt>Session</dt>
                    <dd>{diagnostics.membership.sessionId ?? '-'}</dd>
                </div>
                <div>
                    <dt>Expected</dt>
                    <dd>
                        {formatList(diagnostics.membership.expectedClients)}
                    </dd>
                </div>
                <div>
                    <dt>Observed</dt>
                    <dd>
                        {formatList(diagnostics.membership.observedClients)}
                    </dd>
                </div>
                <div>
                    <dt>Ready Peers</dt>
                    <dd>{formatList(diagnostics.membership.readyPeerIds)}</dd>
                </div>
                <div>
                    <dt>Active Peers</dt>
                    <dd>{formatList(diagnostics.membership.activePeerIds)}</dd>
                </div>
                <div>
                    <dt>Missing</dt>
                    <dd>{formatList(diagnostics.membership.missingClients)}</dd>
                </div>
                <div>
                    <dt>Stale</dt>
                    <dd>{formatList(diagnostics.membership.staleClients)}</dd>
                </div>
                <div>
                    <dt>Peer Count</dt>
                    <dd>{diagnostics.membership.peerCount ?? '-'}</dd>
                </div>
                <div>
                    <dt>Lane Health</dt>
                    <dd>{String(diagnostics.membership.laneHealth ?? '-')}</dd>
                </div>
                <div>
                    <dt>NACK</dt>
                    <dd>{formatList(diagnostics.membership.nackCodes)}</dd>
                </div>
            </dl>
            {diagnostics.failure && (
                <div className="rtc-failure">
                    <strong>{diagnostics.failure.message}</strong>
                    <small>
                        {diagnostics.failure.topic ?? 'runtime failure'}
                    </small>
                </div>
            )}
            {bundleVisible && (
                <textarea
                    className="report-output rtc-bundle-output"
                    value={bundleText}
                    readOnly
                    spellCheck={false}
                />
            )}
            {localError && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        localError,
                        uiRedactionOptions(state, authSession),
                    )}
                </div>
            )}
        </section>
    );
}
