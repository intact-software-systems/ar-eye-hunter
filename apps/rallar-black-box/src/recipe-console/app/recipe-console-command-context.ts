import type { RecipeConsoleSeedState } from '../data/recipe-console-models.ts';
import type { RecipeConsoleView } from '../routing/url-state-contract.ts';

export function recipeConsoleCommandContext(
    view: RecipeConsoleView,
    seedState: RecipeConsoleSeedState,
    authBusy: boolean,
    executeTargetPreviewAvailable: boolean,
): string {
    if (view === 'tune') {
        return `Tune · RTC timing · ${seedState.tune.distributedRunId} · Passed · Compare · More`;
    }
    if (view === 'monitor') {
        const failed = seedState.monitor.agentProgress
            .filter(agent => agent.execution === 'failed').length;
        return `Monitor · ${seedState.monitor.seed.distributedRun.distributedRunId} · Failed · ${failed}/${seedState.monitor.agentProgress.length} agents failed`;
    }
    if (view === 'execute') {
        const { applicationId, workspaceId, groupId } = seedState.execute.group;
        if (!executeTargetPreviewAvailable) {
            return `Execute · Preview · Target preview unavailable · ${applicationId}/${workspaceId}/${groupId}`;
        }
        return `Execute · Preview · ${seedState.execute.defaultTargetIds.length}/${seedState.execute.targetRows.length} targetable · ${applicationId}/${workspaceId}/${groupId}`;
    }
    const label = `${view[0].toUpperCase()}${view.slice(1)}`;
    return `${label} · ${authBusy ? 'Connecting' : 'Seeded offline preview'}`;
}
