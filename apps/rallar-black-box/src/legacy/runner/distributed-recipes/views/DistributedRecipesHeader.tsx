import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { Metric } from '../../../shared/Metric.tsx';

type DistributedRecipesHeaderProps = Readonly<{
    status: string;
    busy: boolean;
    baseUrl: string;
    token: string;
    selectedRunId: string;
    runOptions: readonly Readonly<{ runId: string }>[];
    group: RallarBlackBoxDistributedGroupRef;
    selectedRecipeCount: number;
    liveSelectedRecipeCount: number;
    usesWorldFleetTargets: boolean;
    worldFleetPreviewSelected?: number;
    worldFleetStageStartBlocked: boolean;
    expectedParticipantCount: number;
    selectedAgentCount: number;
    targetableAgentCount: number;
    distributedRunCount: number;
    redactedError?: string;
    manifestValidation?: string;
    onBaseUrlChange(value: string): void;
    onTokenChange(value: string): void;
    onRunChange(value: string): void | Promise<void>;
    onRefresh(): void | Promise<void>;
    onResolveTargets(): void | Promise<void>;
}>;

export function DistributedRecipesHeader(props: DistributedRecipesHeaderProps) {
    return (
        <>
            <div className="panel-heading">
                <h2>Distributed Recipes</h2>
                <span>{props.status}</span>
            </div>
            <div className="distributed-toolbar">
                <label className="field">
                    <span>Control HTTP Base URL</span>
                    <input
                        value={props.baseUrl}
                        onChange={(event) =>
                            props.onBaseUrlChange(event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Token</span>
                    <input
                        value={props.token}
                        onChange={(event) =>
                            props.onTokenChange(event.target.value)
                        }
                        type="password"
                        autoComplete="off"
                    />
                </label>
                <label className="field">
                    <span>Control Run</span>
                    <select
                        value={props.selectedRunId}
                        onChange={(event) =>
                            void props.onRunChange(event.target.value)
                        }
                    >
                        <option value="">Select run</option>
                        {props.runOptions.map((option) => (
                            <option key={option.runId} value={option.runId}>
                                {option.runId}
                            </option>
                        ))}
                    </select>
                </label>
                <button
                    type="button"
                    disabled={props.busy}
                    onClick={() => void props.onRefresh()}
                >
                    Refresh
                </button>
                <button
                    type="button"
                    disabled={props.busy || !props.selectedRunId}
                    onClick={() => void props.onResolveTargets()}
                >
                    Resolve targets
                </button>
            </div>
            <div className="distributed-summary-grid">
                <Metric
                    label="Group"
                    value={props.group.groupId || 'not set'}
                    tone={props.group.groupId ? 'active' : 'bad'}
                />
                <Metric
                    label="Scope"
                    value={`${props.group.applicationId || '-'}/${props.group.workspaceId || '-'}`}
                />
                <Metric
                    label="Recipes"
                    value={String(props.selectedRecipeCount)}
                    tone={props.selectedRecipeCount > 0 ? 'good' : 'bad'}
                />
                <Metric
                    label="Targets"
                    value={props.usesWorldFleetTargets
                        ? `${props.worldFleetPreviewSelected ?? 0}/${props.expectedParticipantCount}`
                        : `${props.selectedAgentCount}/${props.targetableAgentCount}`}
                    tone={props.usesWorldFleetTargets
                        ? props.worldFleetStageStartBlocked ? 'bad' : 'active'
                        : props.selectedAgentCount > 0 ? 'active' : 'bad'}
                />
                <Metric
                    label="Live recipes"
                    value={String(props.liveSelectedRecipeCount)}
                    tone={props.liveSelectedRecipeCount > 0 ? 'warn' : 'muted'}
                />
                <Metric
                    label="Distributed runs"
                    value={String(props.distributedRunCount)}
                />
            </div>
            {props.redactedError !== undefined && (
                <div className="workbench-error run-manager-error" role="status">
                    {props.redactedError}
                </div>
            )}
            {props.manifestValidation && (
                <div className="workbench-error run-manager-error" role="status">
                    {props.manifestValidation}
                </div>
            )}
            {props.liveSelectedRecipeCount > 0 && (
                <div className="distributed-warning" role="status">
                    Live recipes can send real HTTP, WebSocket, or RTC traffic
                    through connected browser agents.
                </div>
            )}
        </>
    );
}
