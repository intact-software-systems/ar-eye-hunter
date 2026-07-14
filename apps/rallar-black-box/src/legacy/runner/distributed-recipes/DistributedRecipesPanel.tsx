import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { DistributedRunMonitorPanel } from '../distributed/DistributedRunMonitorPanel.tsx';
import { DistributedRecipeAuthoringSection } from './authoring/DistributedRecipeAuthoringSection.tsx';
import { DistributedRunHistorySection } from './history/DistributedRunHistorySection.tsx';
import { useDistributedRecipeBuilder } from './use-distributed-recipe-builder.ts';
import { useDistributedRecipesActions } from './use-distributed-recipes-actions.ts';
import { useDistributedRecipesRemoteState } from './use-distributed-recipes-remote-state.ts';
import { DistributedManifestPreviewPanel } from './views/DistributedManifestPreviewPanel.tsx';
import { DistributedRecipeCatalogPanel } from './views/DistributedRecipeCatalogPanel.tsx';
import { DistributedRecipesHeader } from './views/DistributedRecipesHeader.tsx';
import { DistributedRunControlPanel } from './views/DistributedRunControlPanel.tsx';
import { DistributedTargetResolutionPanel } from './views/DistributedTargetResolutionPanel.tsx';
import { useLegacyDiagnosticContext } from
    '../../diagnostics/context/LegacyDiagnosticContextBar.tsx';

type DistributedRecipesPanelProps = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    globalValues: CommandCenterGlobalValues;
}>;

export function DistributedRecipesPanel({
    state, bootstrap, control, globalValues,
}: DistributedRecipesPanelProps) {
    const diagnosticContext = useLegacyDiagnosticContext().context;
    const initialControlRunId = diagnosticContext?.controlRunId;
    const initialDistributedRunId = diagnosticContext?.distributedRunId;
    const contextKey = JSON.stringify([
        initialControlRunId,
        initialDistributedRunId,
    ]);
    return (
        <DistributedRecipesPanelVisit
            key={contextKey}
            state={state}
            bootstrap={bootstrap}
            control={control}
            globalValues={globalValues}
            initialControlRunId={initialControlRunId}
            initialDistributedRunId={initialDistributedRunId}
        />
    );
}

function DistributedRecipesPanelVisit({
    state,
    bootstrap,
    control,
    globalValues,
    initialControlRunId,
    initialDistributedRunId,
}: DistributedRecipesPanelProps & Readonly<{
    initialControlRunId?: string;
    initialDistributedRunId?: string;
}>) {
    const remote = useDistributedRecipesRemoteState({
        state,
        bootstrap,
        control,
        initialControlRunId,
        initialDistributedRunId,
    });
    const builder = useDistributedRecipeBuilder({
        globalValues,
        selectedRunId: remote.selectedRunId,
        run: remote.run,
        distributedRuns: remote.distributedRuns,
        selectedDistributedRun: remote.selectedDistributedRun,
        targetResolutionPreview: remote.targetResolutionPreview,
        monitorAgentProgress: remote.selectedMonitor?.agentProgress,
        initialDistributedRunId,
        diagnosticSelectionIssue: remote.diagnosticSelectionIssue,
    });
    const actions = useDistributedRecipesActions({
        bootstrap,
        control,
        roomId: globalValues.roomId,
        remote,
        builder,
    });

    return (
        <section className="panel distributed-recipes-panel">
            <DistributedRecipesHeader
                status={remote.busyAction ?? remote.lastAction ?? 'idle'}
                busy={Boolean(remote.busyAction)}
                baseUrl={remote.baseUrl}
                token={remote.token}
                selectedRunId={remote.selectedRunId}
                runOptions={remote.runOptions}
                group={builder.groupRef}
                selectedRecipeCount={builder.selectedRecipes.length}
                liveSelectedRecipeCount={builder.liveSelectedRecipeCount}
                usesWorldFleetTargets={builder.usesWorldFleetTargets}
                worldFleetPreviewSelected={builder.worldFleetPreviewSelected}
                worldFleetStageStartBlocked={builder.worldFleetStageStartBlocked}
                expectedParticipantCount={builder.expectedParticipantCount}
                selectedAgentCount={builder.selectedAgentIds.length}
                targetableAgentCount={builder.targetableRows.length}
                distributedRunCount={remote.distributedRuns.length}
                redactedError={
                    remote.diagnosticSelectionIssue ?? remote.redactedError
                }
                manifestValidation={builder.manifestValidation}
                onBaseUrlChange={remote.setBaseUrl}
                onTokenChange={remote.setToken}
                onRunChange={actions.loadRun}
                onRefresh={actions.refresh}
                onResolveTargets={actions.resolveTargets}
            />
            <DistributedRecipeAuthoringSection
                manifest={builder.manifest}
                globalValues={globalValues}
                baseUrl={remote.baseUrl}
                token={remote.token}
                selectedRunId={remote.selectedRunId}
                distributedRunId={builder.distributedRunId}
                targetPolicyMode={builder.targetPolicyMode}
                rolePattern={builder.rolePattern}
                ackTimeoutMs={builder.ackTimeoutMs}
                barrierEnabled={builder.barrierEnabled}
                barrierTimeoutMs={builder.barrierTimeoutMs}
                startMode={builder.startMode}
                selectedAgentIds={builder.selectedAgentIds}
                selectedRecipes={builder.selectedRecipes}
                onLastAction={remote.setLastAction}
            />
            <div className="distributed-layout">
                <DistributedRecipeCatalogPanel
                    query={builder.query}
                    profile={builder.profile}
                    profileOptions={builder.profileOptions}
                    rtcRealtimeSelected={builder.rtcRealtimeSelected}
                    rtcRealtimeDurationSeconds={builder.rtcRealtimeDurationSeconds}
                    rtcRealtimeFrameCount={builder.rtcRealtimeFrameCount}
                    filteredRecipes={builder.filteredRecipes}
                    selectedRecipeIds={builder.selectedRecipeIds}
                    onQueryChange={builder.setQuery}
                    onProfileChange={builder.setProfile}
                    onRtcRealtimeDurationChange={builder.setRtcRealtimeDurationSeconds}
                    onToggleRecipe={actions.toggleRecipe}
                />
                <DistributedTargetResolutionPanel
                    targetRowCount={builder.targetRows.length}
                    targetPolicyMode={builder.targetPolicyMode}
                    rolePattern={builder.rolePattern}
                    usesWorldFleetTargets={builder.usesWorldFleetTargets}
                    expectedParticipantCount={builder.expectedParticipantCount}
                    ackTimeoutMs={builder.ackTimeoutMs}
                    barrierEnabled={builder.barrierEnabled}
                    barrierTimeoutMs={builder.barrierTimeoutMs}
                    startMode={builder.startMode}
                    startDelayMs={builder.startDelayMs}
                    activeTargetResolution={builder.activeTargetResolution}
                    selectedAgentCount={builder.selectedAgentIds.length}
                    targetableAgentCount={builder.targetableRows.length}
                    groupId={builder.groupRef.groupId}
                    agentRows={builder.distributedTargetAgentRows}
                    agentSummary={builder.distributedTargetAgentSummary}
                    selectedAgentIds={builder.selectedAgentSet}
                    onTargetPolicyModeChange={builder.setTargetPolicyMode}
                    onRolePatternChange={actions.selectRolePattern}
                    onExpectedParticipantCountChange={builder.setExpectedParticipantCount}
                    onAckTimeoutMsChange={builder.setAckTimeoutMs}
                    onBarrierEnabledChange={builder.setBarrierEnabled}
                    onBarrierTimeoutMsChange={builder.setBarrierTimeoutMs}
                    onStartModeChange={builder.setStartMode}
                    onStartDelayMsChange={builder.setStartDelayMs}
                    onToggleAgent={actions.toggleAgent}
                />
                <DistributedRunControlPanel
                    busy={Boolean(remote.busyAction)}
                    manifestValidation={builder.manifestValidation}
                    worldFleetBlockReason={builder.worldFleetBlockReason}
                    distributedRunId={builder.distributedRunId}
                    selectedDistributedRun={remote.selectedDistributedRun}
                    currentDistributedRuns={remote.currentDistributedRuns}
                    artifactBundle={remote.artifactBundle}
                    onDistributedRunIdChange={actions.changeDistributedRunId}
                    onGenerateNewRunId={actions.generateNewRunId}
                    onCreateRun={actions.createRun}
                    onStageRun={actions.stageRun}
                    onStartRun={actions.startRun}
                    onCancelRun={actions.cancelRun}
                    onLoadArtifact={actions.loadArtifact}
                    onCopyArtifact={actions.copyArtifact}
                    onLoadDistributedRun={actions.loadDistributedRun}
                />
                <DistributedManifestPreviewPanel
                    manifestValidation={builder.manifestValidation}
                    selectedRecipePreflights={builder.selectedRecipePreflights}
                    selectedPreflightEffectiveOperations={builder.selectedPreflightEffectiveOperations}
                    selectedPreflightWarnings={builder.selectedPreflightWarnings}
                    selectedPreflightErrors={builder.selectedPreflightErrors}
                    manifest={builder.manifest}
                    manifestAuthoringValidation={builder.manifestAuthoringValidation}
                />
                <DistributedRunMonitorPanel monitor={remote.selectedMonitor} />
                <DistributedRunHistorySection
                    distributedRuns={remote.distributedRuns}
                    selectedDistributedRun={remote.selectedDistributedRun}
                    run={remote.run}
                    loadDistributedRun={actions.loadDistributedRun}
                />
            </div>
        </section>
    );
}
