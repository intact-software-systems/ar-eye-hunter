import type { AppTabId } from '../../../app-tabs.ts';
import {
    useRunnerRecipesController,
    type UseRunnerRecipesControllerInput,
} from './use-runner-recipes-controller.ts';
import { RunnerRecipeCatalogList } from './views/RunnerRecipeCatalogList.tsx';
import { RunnerRecipeDetail } from './views/RunnerRecipeDetail.tsx';
import { RunnerRecipesOverview } from './views/RunnerRecipesOverview.tsx';

type RunnerRecipesPanelProps = UseRunnerRecipesControllerInput &
    Readonly<{ onOpenTab(tab: AppTabId): void }>;

export function RunnerRecipesPanel({
    state, bootstrap, control, authSession, globalValues, busy, runState,
    lastError, onDistributedRunStarted, onOpenTab,
}: RunnerRecipesPanelProps) {
    const {
        selectedRecipe, launchState, busyAction, localDisabledReason,
        localRunning, distributedDisabledReason, runLocalRecipe,
        runDistributedRecipe, readiness, refreshReadiness, openAgentTabs,
        groupRef, recipeAgentRows, recipeAgentSummary, agentRunId,
        agentPrefix, agentCount, agentRestoreSession, agentControlWsUrl,
        controlRun, agentLaunchUrls, agentLaunchMessage, setAgentRunId,
        setControlRunId, setControlRun, setAgentPrefix, setAgentCount,
        setAgentRestoreSession, copyAgentLinks, query, setQuery, profile,
        setProfile, profileOptions, sourceFilter, setSourceFilter,
        controlBaseUrl, setControlBaseUrl, controlToken, setControlToken,
        brokeredControlToken, brokeredControlTokenError, filteredRecipes,
        catalog, apiProbe, controlProbe, targetableRows, connectedAgentCount,
        setSelectedRecipeId, setShowEditor, controlRunId, recipePreflight,
        launchMessage, launchError, history, failures, latestResult,
        firstFailure, distributedRun, artifactBundle, showEditor,
        copyText,
    } = useRunnerRecipesController({
        state,
        bootstrap,
        control,
        authSession,
        globalValues,
        busy,
        runState,
        lastError,
        onDistributedRunStarted,
    });

    return (
        <section className="panel runner-recipes-panel">
            <RunnerRecipesOverview
                selectedRecipe={selectedRecipe}
                launchState={launchState}
                busyAction={busyAction}
                localDisabledReason={localDisabledReason}
                localRunning={localRunning}
                distributedDisabledReason={distributedDisabledReason}
                runLocalRecipe={runLocalRecipe}
                runDistributedRecipe={runDistributedRecipe}
                readiness={readiness}
                refreshReadiness={refreshReadiness}
                openAgentTabs={openAgentTabs}
                groupRef={groupRef}
                recipeAgentRows={recipeAgentRows}
                recipeAgentSummary={recipeAgentSummary}
                agentRunId={agentRunId}
                agentPrefix={agentPrefix}
                agentCount={agentCount}
                agentRestoreSession={agentRestoreSession}
                bootstrap={bootstrap}
                authSession={authSession}
                agentControlWsUrl={agentControlWsUrl}
                globalValues={globalValues}
                controlRun={controlRun}
                agentLaunchUrls={agentLaunchUrls}
                agentLaunchMessage={agentLaunchMessage}
                setAgentRunId={setAgentRunId}
                setControlRunId={setControlRunId}
                setControlRun={setControlRun}
                setAgentPrefix={setAgentPrefix}
                setAgentCount={setAgentCount}
                setAgentRestoreSession={setAgentRestoreSession}
                copyAgentLinks={copyAgentLinks}
                query={query}
                setQuery={setQuery}
                profile={profile}
                setProfile={setProfile}
                profileOptions={profileOptions}
                sourceFilter={sourceFilter}
                setSourceFilter={setSourceFilter}
                controlBaseUrl={controlBaseUrl}
                setControlBaseUrl={setControlBaseUrl}
                controlToken={controlToken}
                setControlToken={setControlToken}
                brokeredControlToken={brokeredControlToken}
                brokeredControlTokenError={brokeredControlTokenError}
                filteredRecipes={filteredRecipes}
                catalog={catalog}
                apiProbe={apiProbe}
                controlProbe={controlProbe}
                targetableRows={targetableRows}
                connectedAgentCount={connectedAgentCount}
            />
            <div className="runner-recipes-layout">
                <RunnerRecipeCatalogList
                    filteredRecipes={filteredRecipes}
                    selectedRecipe={selectedRecipe}
                    localDisabledReason={localDisabledReason}
                    localRunning={localRunning}
                    distributedDisabledReason={distributedDisabledReason}
                    setSelectedRecipeId={setSelectedRecipeId}
                    runLocalRecipe={runLocalRecipe}
                    runDistributedRecipe={runDistributedRecipe}
                    setShowEditor={setShowEditor}
                    copyText={copyText}
                />
                <RunnerRecipeDetail
                    selectedRecipe={selectedRecipe}
                    launchState={launchState}
                    localDisabledReason={localDisabledReason}
                    localRunning={localRunning}
                    distributedDisabledReason={distributedDisabledReason}
                    runLocalRecipe={runLocalRecipe}
                    runDistributedRecipe={runDistributedRecipe}
                    controlRunId={controlRunId}
                    globalValues={globalValues}
                    recipePreflight={recipePreflight}
                    launchMessage={launchMessage}
                    launchError={launchError}
                    lastError={lastError}
                    runState={runState}
                    history={history}
                    failures={failures}
                    latestResult={latestResult}
                    firstFailure={firstFailure}
                    distributedRun={distributedRun}
                    artifactBundle={artifactBundle}
                    state={state}
                    showEditor={showEditor}
                    copyText={copyText}
                    onOpenTab={onOpenTab}
                />
            </div>
        </section>
    );
}
