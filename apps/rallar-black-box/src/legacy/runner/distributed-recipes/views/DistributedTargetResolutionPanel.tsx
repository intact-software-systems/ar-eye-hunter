import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    DISTRIBUTED_RECIPE_ROLE_PATTERN_OPTIONS,
    type DistributedRecipeRolePattern,
    type DistributedRecipeTargetPolicyMode,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type {
    ControlAgentBoardRow,
    ControlAgentBoardSummary,
} from '../../../../control-agent-board.ts';
import { ControlAgentBoardPanel } from '../../agents/ControlAgentBoardPanel.tsx';

type DistributedTargetResolutionPanelProps = Readonly<{
    targetRowCount: number;
    targetPolicyMode: DistributedRecipeTargetPolicyMode;
    rolePattern: DistributedRecipeRolePattern;
    usesWorldFleetTargets: boolean;
    expectedParticipantCount: number;
    ackTimeoutMs: number;
    barrierEnabled: boolean;
    barrierTimeoutMs: number;
    startMode: RallarBlackBoxDistributedRunManifest['startMode'];
    startDelayMs: number;
    activeTargetResolution?: RallarBlackBoxDistributedTargetResolution;
    selectedAgentCount: number;
    targetableAgentCount: number;
    groupId: string;
    agentRows: readonly ControlAgentBoardRow[];
    agentSummary: ControlAgentBoardSummary;
    selectedAgentIds: ReadonlySet<string>;
    onTargetPolicyModeChange(value: DistributedRecipeTargetPolicyMode): void;
    onRolePatternChange(value: DistributedRecipeRolePattern): void;
    onExpectedParticipantCountChange(value: number): void;
    onAckTimeoutMsChange(value: number): void;
    onBarrierEnabledChange(value: boolean): void;
    onBarrierTimeoutMsChange(value: number): void;
    onStartModeChange(value: RallarBlackBoxDistributedRunManifest['startMode']): void;
    onStartDelayMsChange(value: number): void;
    onToggleAgent(agentId: string): void;
}>;

export function DistributedTargetResolutionPanel(props: DistributedTargetResolutionPanelProps) {
    return (
        <section className="distributed-subpanel">
            <div className="section-heading">
                <h3>Target Resolution</h3>
                <span>{props.targetRowCount} agents</span>
            </div>
            <div className="distributed-options-grid">
                <label className="field">
                    <span>Target Policy</span>
                    <select
                        value={props.targetPolicyMode}
                        onChange={(event) =>
                            props.onTargetPolicyModeChange(
                                event.target
                                    .value as DistributedRecipeTargetPolicyMode,
                            )
                        }
                    >
                        <option value="selected-agents">Selected agents</option>
                        <option value="all-online-group-members">
                            All online group members
                        </option>
                        <option
                            value="role-map"
                            disabled={props.rolePattern === 'all-agents'}
                        >
                            Role map
                        </option>
                    </select>
                </label>
                <label className="field">
                    <span>Role Pattern</span>
                    <select
                        value={props.rolePattern}
                        onChange={(event) =>
                            props.onRolePatternChange(
                                event.target.value as DistributedRecipeRolePattern,
                            )
                        }
                    >
                        {DISTRIBUTED_RECIPE_ROLE_PATTERN_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </label>
                {props.usesWorldFleetTargets && (
                    <label className="field">
                        <span>Expected Participants</span>
                        <input
                            type="number"
                            min={1}
                            value={props.expectedParticipantCount}
                            onChange={(event) =>
                                props.onExpectedParticipantCountChange(
                                    Number.parseInt(event.target.value, 10) || 1,
                                )
                            }
                        />
                    </label>
                )}
                <label className="field">
                    <span>ACK Timeout Ms</span>
                    <input
                        type="number"
                        min={1}
                        value={props.ackTimeoutMs}
                        onChange={(event) =>
                            props.onAckTimeoutMsChange(
                                Number.parseInt(event.target.value, 10) || 1,
                            )
                        }
                    />
                </label>
                <label className="field">
                    <span>Barrier</span>
                    <select
                        value={props.barrierEnabled ? 'enabled' : 'disabled'}
                        onChange={(event) =>
                            props.onBarrierEnabledChange(
                                event.target.value === 'enabled',
                            )
                        }
                    >
                        <option value="disabled">Disabled</option>
                        <option value="enabled">Enabled</option>
                    </select>
                </label>
                {props.barrierEnabled && (
                    <label className="field">
                        <span>Barrier Timeout Ms</span>
                        <input
                            type="number"
                            min={1}
                            value={props.barrierTimeoutMs}
                            onChange={(event) =>
                                props.onBarrierTimeoutMsChange(
                                    Number.parseInt(event.target.value, 10) || 1,
                                )
                            }
                        />
                    </label>
                )}
                <label className="field">
                    <span>Start Mode</span>
                    <select
                        value={props.startMode}
                        onChange={(event) =>
                            props.onStartModeChange(
                                event.target
                                    .value as RallarBlackBoxDistributedRunManifest['startMode'],
                            )
                        }
                    >
                        <option value="manual">Manual</option>
                        <option value="auto-after-ready">Auto after ready</option>
                        <option value="scheduled">Scheduled</option>
                    </select>
                </label>
                {props.startMode === 'scheduled' && (
                    <label className="field">
                        <span>Start Delay Ms</span>
                        <input
                            type="number"
                            min={1}
                            value={props.startDelayMs}
                            onChange={(event) =>
                                props.onStartDelayMsChange(
                                    Number.parseInt(event.target.value, 10) || 1,
                                )
                            }
                        />
                    </label>
                )}
            </div>
            {props.usesWorldFleetTargets && (
                <div className="distributed-warning" role="status">
                    {props.activeTargetResolution
                        ? `Server preview selected ${props.activeTargetResolution.summary.selected}/${props.expectedParticipantCount}; roles ${Object.entries(props.activeTargetResolution.summary.roleCounts).map(([role, count]) => `${role}:${count}`).join(', ') || 'none'}; blockers ${props.activeTargetResolution.blockers.length}.`
                        : 'Resolve targets to preview online world-fleet participants and derived roles.'}
                </div>
            )}
            <ControlAgentBoardPanel
                title="Resolved Targets"
                subtitle={`${props.selectedAgentCount}/${props.targetableAgentCount} selected for ${props.groupId || 'missing group'}`}
                rows={props.agentRows}
                summary={props.agentSummary}
                emptyMessage="No control agents in selected run"
                selectedAgentIds={props.selectedAgentIds}
                onToggleAgent={props.onToggleAgent}
                disableUntargetableSelection
                compact
            />
        </section>
    );
}
