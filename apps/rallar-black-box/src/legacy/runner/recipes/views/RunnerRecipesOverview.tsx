import type { Dispatch, SetStateAction } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { ControlAgentBoardRow, ControlAgentBoardSummary } from '../../../../control-agent-board.ts';
import type { ControlRunSnapshot } from '../../../../control-run-manager.ts';
import type { DistributedRecipeTargetRow } from '../../../../distributed-recipes.ts';
import type { BlackBoxControlTokenSession } from '../../../../control-operator-token.ts';
import type { RecipeLaunchState, RunnerReadinessStatus } from '../../../../runner-readiness.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../../shell/global-context-model.ts';
import { Metric } from '../../../shared/Metric.tsx';
import { formatTime } from '../../../shared/time-format.ts';
import { ControlAgentBoardPanel } from '../../agents/ControlAgentBoardPanel.tsx';
import { RunnerAgentSetupPanel } from '../RunnerAgentSetupPanel.tsx';
import { RunnerReadinessPanel } from '../RunnerReadinessPanel.tsx';
import type { RunnerRecipeCatalogEntry, RunnerRecipeSource } from '../runner-recipe-catalog.ts';
import type { RunnerServiceProbe } from '../runner-launch-presentation.ts';
import { runnerLaunchTone } from '../runner-launch-presentation.ts';

type RunnerRecipesOverviewProps = Readonly<{
    selectedRecipe?: RunnerRecipeCatalogEntry;
    launchState: RecipeLaunchState;
    busyAction?: string;
    localDisabledReason?: string;
    localRunning: boolean;
    distributedDisabledReason?: string;
    runLocalRecipe(): Promise<void>;
    runDistributedRecipe(): Promise<void>;
    readiness: RunnerReadinessStatus;
    refreshReadiness(): Promise<void>;
    openAgentTabs(): Promise<void>;
    groupRef: RallarBlackBoxDistributedGroupRef;
    recipeAgentRows: readonly ControlAgentBoardRow[];
    recipeAgentSummary: ControlAgentBoardSummary;
    agentRunId: string;
    agentPrefix: string;
    agentCount: number;
    agentRestoreSession: boolean;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    agentControlWsUrl: string;
    globalValues: CommandCenterGlobalValues;
    controlRun?: ControlRunSnapshot;
    agentLaunchUrls: readonly string[];
    agentLaunchMessage?: string;
    setAgentRunId: Dispatch<SetStateAction<string>>;
    setControlRunId: Dispatch<SetStateAction<string>>;
    setControlRun: Dispatch<SetStateAction<ControlRunSnapshot | undefined>>;
    setAgentPrefix: Dispatch<SetStateAction<string>>;
    setAgentCount: Dispatch<SetStateAction<number>>;
    setAgentRestoreSession: Dispatch<SetStateAction<boolean>>;
    copyAgentLinks(): Promise<void>;
    query: string;
    setQuery: Dispatch<SetStateAction<string>>;
    profile: string;
    setProfile: Dispatch<SetStateAction<string>>;
    profileOptions: readonly string[];
    sourceFilter: RunnerRecipeSource | 'all';
    setSourceFilter: Dispatch<SetStateAction<RunnerRecipeSource | 'all'>>;
    controlBaseUrl: string;
    setControlBaseUrl: Dispatch<SetStateAction<string>>;
    controlToken: string;
    setControlToken: Dispatch<SetStateAction<string>>;
    brokeredControlToken?: BlackBoxControlTokenSession;
    brokeredControlTokenError?: string;
    filteredRecipes: readonly RunnerRecipeCatalogEntry[];
    catalog: readonly RunnerRecipeCatalogEntry[];
    apiProbe: RunnerServiceProbe;
    controlProbe: RunnerServiceProbe;
    targetableRows: readonly DistributedRecipeTargetRow[];
    connectedAgentCount: number;
}>;

export function RunnerRecipesOverview({
    selectedRecipe, launchState, busyAction, localDisabledReason, localRunning,
    distributedDisabledReason, runLocalRecipe, runDistributedRecipe, readiness,
    refreshReadiness, openAgentTabs, groupRef, recipeAgentRows,
    recipeAgentSummary, agentRunId, agentPrefix, agentCount,
    agentRestoreSession, bootstrap, authSession, agentControlWsUrl, globalValues,
    controlRun, agentLaunchUrls, agentLaunchMessage, setAgentRunId,
    setControlRunId, setControlRun, setAgentPrefix, setAgentCount,
    setAgentRestoreSession, copyAgentLinks, query, setQuery, profile, setProfile,
    profileOptions, sourceFilter, setSourceFilter, controlBaseUrl,
    setControlBaseUrl, controlToken, setControlToken, brokeredControlToken,
    brokeredControlTokenError, filteredRecipes, catalog, apiProbe, controlProbe,
    targetableRows, connectedAgentCount,
}: RunnerRecipesOverviewProps) {
    return (
        <>
            <div className="panel-heading">
                <h2>Recipes</h2>
                <span className={`pill ${runnerLaunchTone(launchState)}`}>
                    {busyAction ?? launchState}
                </span>
            </div>
            {selectedRecipe && (
                <div className="runner-quick-launch-strip runner-evidence-first">
                    <div>
                        <span>Selected recipe</span>
                        <strong>{selectedRecipe.title}</strong>
                        <small>{selectedRecipe.expectedResult}</small>
                    </div>
                    <div className="runner-recipe-actions-primary">
                        <button
                            type="button"
                            disabled={Boolean(localDisabledReason) || localRunning}
                            title={localDisabledReason}
                            onClick={() => void runLocalRecipe()}
                        >
                            Run in this browser
                        </button>
                        <button
                            type="button"
                            disabled={
                                Boolean(distributedDisabledReason) || localRunning
                            }
                            title={distributedDisabledReason}
                            onClick={() => void runDistributedRecipe()}
                        >
                            Run on connected agents
                        </button>
                    </div>
                    {(localDisabledReason || distributedDisabledReason) && (
                        <small className="runner-quick-launch-reason">
                            {localDisabledReason
                                ? `Local: ${localDisabledReason}`
                                : `Distributed: ${distributedDisabledReason}`}
                        </small>
                    )}
                </div>
            )}
            <RunnerReadinessPanel
                checks={readiness.checks}
                message={readiness.primaryMessage}
                refreshing={busyAction === 'refresh-readiness'}
                onRefresh={() => void refreshReadiness()}
                onOpenAgentTabs={openAgentTabs}
            />
            <ControlAgentBoardPanel
                title="Targetable Agents"
                subtitle={
                    selectedRecipe
                        ? `${selectedRecipe.title} against ${groupRef.groupId || 'missing group'}`
                        : 'Select a recipe to resolve connected agents.'
                }
                rows={recipeAgentRows}
                summary={recipeAgentSummary}
                emptyMessage="No control agents in the selected run. Open agent tabs, wait for registration, then refresh."
                compact
            />
            <RunnerAgentSetupPanel
                runId={agentRunId}
                agentPrefix={agentPrefix}
                agentCount={agentCount}
                restoreSession={agentRestoreSession}
                providerMode={bootstrap.providerMode}
                authSession={authSession}
                controlWsUrl={agentControlWsUrl}
                groupId={globalValues.roomId}
                connectedAgents={controlRun?.agents ?? []}
                launchUrls={agentLaunchUrls}
                launchMessage={agentLaunchMessage}
                showConnectedAgents={false}
                onRunIdChange={(value) => {
                    setAgentRunId(value);
                    setControlRunId(value);
                    setControlRun(undefined);
                }}
                onAgentPrefixChange={setAgentPrefix}
                onAgentCountChange={setAgentCount}
                onRestoreSessionChange={setAgentRestoreSession}
                onOpenAgents={openAgentTabs}
                onCopyLinks={() => void copyAgentLinks()}
            />
            <div className="runner-recipes-toolbar">
                <label className="field runner-recipes-search">
                    <span>Search Recipes</span>
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="recipe, transport, profile, evidence"
                    />
                </label>
                <label className="field">
                    <span>Profile</span>
                    <select
                        value={profile}
                        onChange={(event) => setProfile(event.target.value)}
                    >
                        <option value="">All profiles</option>
                        {profileOptions.map((option) => (
                            <option key={option} value={option}>
                                {option}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    <span>Source</span>
                    <select
                        value={sourceFilter}
                        onChange={(event) =>
                            setSourceFilter(
                                event.target.value as RunnerRecipeSource | 'all',
                            )
                        }
                    >
                        <option value="all">All sources</option>
                        <option value="app-local">App-local</option>
                        <option value="shared-test">Shared-test</option>
                    </select>
                </label>
                <label className="field">
                    <span>Control URL</span>
                    <input
                        value={controlBaseUrl}
                        onChange={(event) => setControlBaseUrl(event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Control Token</span>
                    <input
                        value={controlToken}
                        type="password"
                        autoComplete="off"
                        onChange={(event) => setControlToken(event.target.value)}
                    />
                    {!controlToken.trim() && authSession && brokeredControlToken && (
                        <small className="runner-control-token-status">
                            Session control token valid until {formatTime(
                                brokeredControlToken.expiresAtEpochMs,
                            )}
                        </small>
                    )}
                    {!controlToken.trim() && authSession && !brokeredControlToken && (
                        <small className="runner-control-token-status">
                            Session control token will be requested when needed.
                        </small>
                    )}
                    {!controlToken.trim() && brokeredControlTokenError && (
                        <small className="runner-control-token-error">
                            {brokeredControlTokenError}
                        </small>
                    )}
                </label>
            </div>
            <div className="runner-recipes-summary-grid">
                <Metric label="Visible" value={String(filteredRecipes.length)} tone="active" />
                <Metric
                    label="App-local"
                    value={String(
                        catalog.filter((entry) => entry.source === 'app-local').length,
                    )}
                />
                <Metric
                    label="Shared-test"
                    value={String(
                        catalog.filter((entry) => entry.source === 'shared-test').length,
                    )}
                />
                <Metric label="API" value={apiProbe.detail} tone={apiProbe.status === 'online' ? 'good' : apiProbe.status === 'checking' ? 'active' : 'bad'} />
                <Metric label="Control" value={controlProbe.detail} tone={controlProbe.status === 'online' ? 'good' : controlProbe.status === 'checking' ? 'active' : 'bad'} />
                <Metric
                    label="Agents"
                    value={`${targetableRows.length}/${connectedAgentCount}`}
                    tone={targetableRows.length > 0 ? 'good' : 'bad'}
                />
            </div>
        </>
    );
}
