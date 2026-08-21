import type { ControlFleetFailureSignature } from '../../../../control-run-manager.ts';
import { formatTime } from '../../../shared/time-format.ts';
import { shortRunId } from '../../shared/run-id-presentation.ts';
import type { fleetAgentDetail } from '../fleet-derivations.ts';
import { fleetAgentStateTone, fleetRegionLabel } from '../fleet-presentation.ts';

export function RunnerFleetSelectedDetails({
    selectedFailure,
    selectedAgent
}: {
    selectedFailure: ControlFleetFailureSignature | undefined;
    selectedAgent: ReturnType<typeof fleetAgentDetail>;
}) {
    return (
        <>
            {selectedFailure && (
                <section className="fleet-subpanel fleet-selected-failure">
                    <div className="section-heading">
                        <h3>Selected Failure</h3>
                        <span>{selectedFailure.count} hits</span>
                    </div>
                    <h4>{selectedFailure.title}</h4>
                    <p>{selectedFailure.likelyCause}</p>
                    <p>{selectedFailure.nextAction}</p>
                    <dl className="fleet-detail-list">
                        <div>
                            <dt>Agents</dt>
                            <dd>
                                {selectedFailure.affectedAgents.join(', ') ||
                                    '-'}
                            </dd>
                        </div>
                        <div>
                            <dt>Regions</dt>
                            <dd>
                                {selectedFailure.affectedRegions.join(', ') ||
                                    '-'}
                            </dd>
                        </div>
                        <div>
                            <dt>Runs</dt>
                            <dd>
                                {selectedFailure.affectedRuns
                                    .map(shortRunId)
                                    .join(', ') || '-'}
                            </dd>
                        </div>
                    </dl>
                </section>
            )}
            {selectedAgent && (
                <section className="fleet-subpanel fleet-agent-detail">
                    <div className="section-heading">
                        <h3>Agent Detail</h3>
                        <span>{selectedAgent.agent.agentId}</span>
                    </div>
                    <dl className="fleet-detail-list">
                        <div>
                            <dt>Region</dt>
                            <dd>
                                {fleetRegionLabel(
                                    selectedAgent.agent.label
                                )}
                            </dd>
                        </div>
                        <div>
                            <dt>Heartbeat</dt>
                            <dd>
                                {formatTime(
                                    selectedAgent.agent
                                        .lastHeartbeatAtEpochMs
                                )}
                            </dd>
                        </div>
                        <div>
                            <dt>Reconnects</dt>
                            <dd>{selectedAgent.reconnectCount}</dd>
                        </div>
                        <div>
                            <dt>Diagnostics</dt>
                            <dd>{selectedAgent.diagnosticCount}</dd>
                        </div>
                        <div>
                            <dt>Trend</dt>
                            <dd>
                                {selectedAgent.passed} passed / {selectedAgent.failed} failed / {selectedAgent.missing}
                                {' '}
                                missing
                            </dd>
                        </div>
                    </dl>
                    <div className="fleet-agent-run-list">
                        {selectedAgent.runs.map((entry) => (
                            <div
                                className="runner-analysis-row"
                                key={`${entry.run.distributedRunId}-${
                                    entry.outcome?.agentId ?? selectedAgent.agent.agentId
                                }`}
                            >
                                <strong>
                                    {shortRunId(
                                        entry.run.distributedRunId
                                    )}
                                </strong>
                                <span
                                    className={`pill ${fleetAgentStateTone(entry.outcome?.state)}`}
                                >
                                    {entry.outcome?.state ?? 'missing'}
                                </span>
                                <small>
                                    {entry.run.recipeIds.join(', ') ||
                                        'no recipe'}
                                </small>
                            </div>
                        ))}
                    </div>
                </section>
            )}
        </>
    );
}
