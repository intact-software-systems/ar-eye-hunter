import type { RallarBlackBoxControlSnapshot } from '@shared-test/rallar-bb-test/control-client.ts';
import {
    readDistributedRun,
    readDistributedRuns
} from '../../../control-run-manager/control-distributed-run-endpoints.ts';
import { createDefaultControlEndpointRequest } from '../../../control-run-manager/control-endpoint-request.ts';
import { toControlFailureMessage } from '../../../control-run-manager/control-request-failure.ts';
import {
    readControlRunSnapshot,
    readControlServerSnapshot
} from '../../../control-run-manager/control-run-endpoints.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { deriveDistributedDiagnosticSelection } from '../../diagnostics/context/legacy-diagnostic-run-selection.ts';
import { RUN_MANAGER_SNAPSHOT_BOUNDS } from '../shared/control-snapshot-bounds.ts';
import { useLatestRequestGuard } from '../shared/use-latest-request-guard.ts';
import type { DistributedRecipeBuilderModel } from './use-distributed-recipe-builder.ts';
import type { DistributedRecipesRemoteStateModel } from './use-distributed-recipes-remote-state.ts';

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
    builder
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
        diagnosticSelectionAuthority
    } = remote;
    const { distributedRunId, setDistributedRunId } = builder;
    const controlEndpoint = createDefaultControlEndpointRequest({ baseUrl, token });

    const refresh = async (
        preferredRunId = selectedRunId,
        preferredDistributedRunId = distributedRunId
    ): Promise<void> => {
        const request = requests.begin();
        setBusyAction('refresh');
        setError(undefined);
        try {
            const [snapshotOutcome, distributedOutcome] = await Promise.all([
                readControlServerSnapshot({
                    ...controlEndpoint,
                    bounds: RUN_MANAGER_SNAPSHOT_BOUNDS
                }),
                readDistributedRuns(controlEndpoint)
            ]);
            if (!request.isCurrent()) {
                return;
            }
            const serverSnapshot = snapshotOutcome.right;
            const distributedList = distributedOutcome.right;
            if (serverSnapshot === undefined || distributedList === undefined) {
                setError(
                    toControlFailureMessage(snapshotOutcome.left ?? distributedOutcome.left)
                );
                return;
            }

            setSnapshot(serverSnapshot);
            setDistributedRuns(distributedList);
            const diagnosticSelection = diagnosticSelectionAuthority.active
                ? deriveDistributedDiagnosticSelection({
                    requestedControlRunId: diagnosticControlRunId,
                    requestedDistributedRunId: diagnosticDistributedRunId,
                    availableControlRunIds: serverSnapshot.runs.map(
                        (run) => run.runId
                    ),
                    distributedRuns: distributedList
                })
                : undefined;
            if (diagnosticSelection?.issue) {
                setSelectedRunId(diagnosticSelection.controlRunId);
                setRun(undefined);
                setSelectedDistributedRun(undefined);
                setArtifactBundle(undefined);
                diagnosticSelectionAuthority.reportIssue(
                    diagnosticSelection.issue
                );
                setLastAction('Diagnostic run selection unavailable.');
                return;
            }

            const knownRunIds = new Set(
                serverSnapshot.runs.map((option) => option.runId)
            );
            const nextRunId = diagnosticSelection?.controlRunId ?? [
                preferredRunId,
                control.runId,
                bootstrap.runId,
                serverSnapshot.runs[0]?.runId
            ].find((candidate) => candidate && knownRunIds.has(candidate)) ?? '';
            const nextDistributedRunId = diagnosticSelection?.distributedRunId ??
                preferredDistributedRunId;
            setSelectedRunId(nextRunId);
            const nextRunOutcome = nextRunId
                ? await readControlRunSnapshot({
                    ...controlEndpoint,
                    runId: nextRunId,
                    bounds: RUN_MANAGER_SNAPSHOT_BOUNDS
                })
                : undefined;
            if (!request.isCurrent()) {
                return;
            }
            if (nextRunOutcome?.left !== undefined) {
                setError(toControlFailureMessage(nextRunOutcome.left));
                return;
            }

            setRun(nextRunOutcome?.right);
            setSelectedDistributedRun(distributedList.find((item) =>
                item.distributedRunId === nextDistributedRunId &&
                (!diagnosticSelection || item.controlRunId === nextRunId)
            ));
            setArtifactBundle(undefined);
            if (diagnosticSelection) {
                diagnosticSelectionAuthority.finishInitialSelection();
            }
            setLastAction(
                `Refreshed ${serverSnapshot.runs.length} run(s), ${distributedList.length} distributed run(s).`
            );
        }
        catch (caught) {
            if (request.isCurrent()) {
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        }
        finally {
            if (request.isCurrent()) {
                setBusyAction(undefined);
            }
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
        if (!diagnosticSelectionAuthority.active) {
            setError(undefined);
        }
        try {
            const loadOutcome = await readControlRunSnapshot({
                ...controlEndpoint,
                runId,
                bounds: RUN_MANAGER_SNAPSHOT_BOUNDS
            });
            if (!request.isCurrent()) {
                return;
            }
            const loaded = loadOutcome.right;
            if (loaded === undefined) {
                if (!diagnosticSelectionAuthority.active) {
                    setError(toControlFailureMessage(loadOutcome.left));
                }
                return;
            }
            setRun(loaded);
            setSelectedDistributedRun((current) => current?.controlRunId === runId ? current : undefined);
            diagnosticSelectionAuthority.acceptManualSelection();
            setError(undefined);
            setLastAction(`Loaded ${runId}.`);
        }
        catch (caught) {
            if (request.isCurrent() && !diagnosticSelectionAuthority.active) {
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        }
        finally {
            if (request.isCurrent()) {
                setBusyAction(undefined);
            }
        }
    };

    const loadDistributedRun = async (id: string): Promise<void> => {
        const request = requests.begin();
        setDistributedRunId(id);
        setBusyAction('load-distributed-run');
        if (!diagnosticSelectionAuthority.active) {
            setError(undefined);
        }
        try {
            const loadOutcome = await readDistributedRun({
                ...controlEndpoint,
                distributedRunId: id
            });
            if (!request.isCurrent()) {
                return;
            }
            const loaded = loadOutcome.right;
            if (loaded === undefined) {
                if (!diagnosticSelectionAuthority.active) {
                    setError(toControlFailureMessage(loadOutcome.left));
                }
                return;
            }
            const controlRunOutcome = await readControlRunSnapshot({
                ...controlEndpoint,
                runId: loaded.controlRunId,
                bounds: RUN_MANAGER_SNAPSHOT_BOUNDS
            });
            if (!request.isCurrent()) {
                return;
            }
            const controlRun = controlRunOutcome.right;
            if (controlRun === undefined) {
                if (!diagnosticSelectionAuthority.active) {
                    setError(toControlFailureMessage(controlRunOutcome.left));
                }
                return;
            }

            setSelectedDistributedRun(loaded);
            setSelectedRunId(loaded.controlRunId);
            setRun(controlRun);
            setArtifactBundle(undefined);
            diagnosticSelectionAuthority.acceptManualSelection();
            setError(undefined);
            setLastAction(`Loaded ${id}.`);
        }
        catch (caught) {
            if (request.isCurrent() && !diagnosticSelectionAuthority.active) {
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        }
        finally {
            if (request.isCurrent()) {
                setBusyAction(undefined);
            }
        }
    };

    return { refresh, loadRun, loadDistributedRun };
}
