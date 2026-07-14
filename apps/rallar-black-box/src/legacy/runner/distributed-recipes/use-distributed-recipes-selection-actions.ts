import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import {
    fetchControlRunSnapshot,
    fetchControlServerSnapshot,
    fetchDistributedRun,
    fetchDistributedRuns,
} from '../../../control-run-manager.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { deriveDistributedDiagnosticSelection } from
    '../../diagnostics/context/legacy-diagnostic-run-selection.ts';
import { useLatestRequestGuard } from
    '../shared/use-latest-request-guard.ts';
import { RUN_MANAGER_SNAPSHOT_BOUNDS } from
    '../shared/control-snapshot-bounds.ts';
import type { DistributedRecipeBuilderModel } from
    './use-distributed-recipe-builder.ts';
import type { DistributedRecipesRemoteStateModel } from
    './use-distributed-recipes-remote-state.ts';

type DistributedRecipesSelectionActionsInput = Readonly<{
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    remote: DistributedRecipesRemoteStateModel;
    builder: DistributedRecipeBuilderModel;
}>;

export function useDistributedRecipesSelectionActions({
    bootstrap,
    control,
    remote,
    builder,
}: DistributedRecipesSelectionActionsInput) {
    const requests = useLatestRequestGuard();
    const {
        baseUrl,
        token,
        selectedRunId,
        setSelectedRunId,
        setSnapshot,
        setRun,
        setDistributedRuns,
        setSelectedDistributedRun,
        setArtifactBundle,
        setBusyAction,
        setError,
        setLastAction,
        diagnosticControlRunId,
        diagnosticDistributedRunId,
        diagnosticSelectionAuthority,
    } = remote;
    const { distributedRunId, setDistributedRunId } = builder;

    const refresh = async (
        preferredRunId = selectedRunId,
        preferredDistributedRunId = distributedRunId,
    ): Promise<void> => {
        const request = requests.begin();
        setBusyAction('refresh');
        setError(undefined);
        try {
            const [serverSnapshot, distributedList] = await Promise.all([
                fetchControlServerSnapshot({
                    baseUrl,
                    token,
                    bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
                }),
                fetchDistributedRuns({ baseUrl, token }),
            ]);
            if (!request.isCurrent()) return;

            setSnapshot(serverSnapshot);
            setDistributedRuns(distributedList);
            const diagnosticSelection = diagnosticSelectionAuthority.active
                ? deriveDistributedDiagnosticSelection({
                    requestedControlRunId: diagnosticControlRunId,
                    requestedDistributedRunId: diagnosticDistributedRunId,
                    availableControlRunIds: serverSnapshot.runs.map(
                        run => run.runId,
                    ),
                    distributedRuns: distributedList,
                })
                : undefined;
            if (diagnosticSelection?.issue) {
                setSelectedRunId(diagnosticSelection.controlRunId);
                setRun(undefined);
                setSelectedDistributedRun(undefined);
                setArtifactBundle(undefined);
                diagnosticSelectionAuthority.reportIssue(
                    diagnosticSelection.issue,
                );
                setLastAction('Diagnostic run selection unavailable.');
                return;
            }

            const knownRunIds = new Set(
                serverSnapshot.runs.map(option => option.runId),
            );
            const nextRunId = diagnosticSelection?.controlRunId ?? [
                preferredRunId,
                control.runId,
                bootstrap.runId,
                serverSnapshot.runs[0]?.runId,
            ].find(candidate => candidate && knownRunIds.has(candidate)) ?? '';
            const nextDistributedRunId =
                diagnosticSelection?.distributedRunId ??
                preferredDistributedRunId;
            setSelectedRunId(nextRunId);
            const nextRun = nextRunId
                ? await fetchControlRunSnapshot({
                    baseUrl,
                    token,
                    runId: nextRunId,
                    bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
                })
                : undefined;
            if (!request.isCurrent()) return;

            setRun(nextRun);
            setSelectedDistributedRun(distributedList.find(item =>
                item.distributedRunId === nextDistributedRunId &&
                (!diagnosticSelection || item.controlRunId === nextRunId)));
            setArtifactBundle(undefined);
            if (diagnosticSelection) {
                diagnosticSelectionAuthority.finishInitialSelection();
            }
            setLastAction(
                `Refreshed ${serverSnapshot.runs.length} run(s), ${distributedList.length} distributed run(s).`,
            );
        } catch (caught) {
            if (request.isCurrent()) {
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        } finally {
            if (request.isCurrent()) setBusyAction(undefined);
        }
    };

    const loadRun = async (runId: string): Promise<void> => {
        const request = requests.begin();
        setSelectedRunId(runId);
        setArtifactBundle(undefined);
        if (!runId) {
            setRun(undefined);
            setBusyAction(undefined);
            setError(undefined);
            return;
        }
        setBusyAction('load-run');
        if (!diagnosticSelectionAuthority.active) setError(undefined);
        try {
            const loaded = await fetchControlRunSnapshot({
                baseUrl,
                token,
                runId,
                bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
            });
            if (!request.isCurrent()) return;
            setRun(loaded);
            setSelectedDistributedRun(current =>
                current?.controlRunId === runId ? current : undefined);
            diagnosticSelectionAuthority.acceptManualSelection();
            setError(undefined);
            setLastAction(`Loaded ${runId}.`);
        } catch (caught) {
            if (request.isCurrent() && !diagnosticSelectionAuthority.active) {
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        } finally {
            if (request.isCurrent()) setBusyAction(undefined);
        }
    };

    const loadDistributedRun = async (id: string): Promise<void> => {
        const request = requests.begin();
        setDistributedRunId(id);
        setBusyAction('load-distributed-run');
        if (!diagnosticSelectionAuthority.active) setError(undefined);
        try {
            const loaded = await fetchDistributedRun({
                baseUrl,
                token,
                distributedRunId: id,
            });
            if (!request.isCurrent()) return;
            const controlRun = await fetchControlRunSnapshot({
                baseUrl,
                token,
                runId: loaded.controlRunId,
                bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
            });
            if (!request.isCurrent()) return;

            setSelectedDistributedRun(loaded);
            setSelectedRunId(loaded.controlRunId);
            setRun(controlRun);
            setArtifactBundle(undefined);
            diagnosticSelectionAuthority.acceptManualSelection();
            setError(undefined);
            setLastAction(`Loaded ${id}.`);
        } catch (caught) {
            if (request.isCurrent() && !diagnosticSelectionAuthority.active) {
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        } finally {
            if (request.isCurrent()) setBusyAction(undefined);
        }
    };

    return { refresh, loadRun, loadDistributedRun };
}
