import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { useEffect, useMemo, useState } from 'react';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import {
    controlHttpBaseUrlFromWsUrl,
    type ControlDistributedRunArtifactBundle,
    type ControlDistributedRunSnapshot,
    type ControlRunSnapshot,
    type ControlServerSnapshot,
    type RallarBlackBoxDistributedTargetResolution,
} from '../../../control-run-manager.ts';
import { deriveDistributedRunMonitor } from '../../../distributed-recipes.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import { deriveDistributedDiagnosticSelection } from
    '../../diagnostics/context/legacy-diagnostic-run-selection.ts';

type UseDistributedRecipesRemoteStateInput = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    initialControlRunId?: string;
    initialDistributedRunId?: string;
}>;

export function useDistributedRecipesRemoteState({
    state,
    bootstrap,
    control,
    initialControlRunId,
    initialDistributedRunId,
}: UseDistributedRecipesRemoteStateInput) {
    const [baseUrl, setBaseUrl] = useState(() =>
        controlHttpBaseUrlFromWsUrl(control.url ?? bootstrap.controlUrl),
    );
    const [token, setToken] = useState('');
    const [selectedRunId, setSelectedRunId] = useState(
        initialControlRunId ?? control.runId ?? bootstrap.runId ?? '',
    );
    const [snapshot, setSnapshot] = useState<
        ControlServerSnapshot | undefined
    >();
    const [run, setRun] = useState<ControlRunSnapshot | undefined>();
    const [distributedRuns, setDistributedRuns] = useState<
        readonly ControlDistributedRunSnapshot[]
    >([]);
    const [selectedDistributedRun, setSelectedDistributedRun] = useState<
        ControlDistributedRunSnapshot | undefined
    >();
    const [targetResolutionPreview, setTargetResolutionPreview] = useState<
        RallarBlackBoxDistributedTargetResolution | undefined
    >();
    const [artifactBundle, setArtifactBundle] = useState<
        ControlDistributedRunArtifactBundle | undefined
    >();
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [lastAction, setLastAction] = useState<string | undefined>();
    const runOptions = useMemo(
        () =>
            [...(snapshot?.runs ?? [])].sort(
                (left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs,
            ),
        [snapshot],
    );
    const currentDistributedRuns = useMemo(
        () =>
            distributedRuns
                .filter((item) => item.controlRunId === selectedRunId)
                .sort(
                    (left, right) =>
                        right.updatedAtEpochMs - left.updatedAtEpochMs,
                ),
        [distributedRuns, selectedRunId],
    );
    const selectedMonitor = useMemo(
        () =>
            selectedDistributedRun
                ? deriveDistributedRunMonitor({
                      distributedRun: selectedDistributedRun,
                      controlRun: run,
                      artifactBundle,
                  })
                : undefined,
        [artifactBundle, run, selectedDistributedRun],
    );
    const redactedError = error
        ? String(
              redactRallarBlackBoxValue(
                  error,
                  uiRedactionOptions(state, undefined, [token]),
              ),
          )
        : undefined;
    const diagnosticSelection = useMemo(
        () => snapshot && (initialControlRunId || initialDistributedRunId)
            ? deriveDistributedDiagnosticSelection({
                requestedControlRunId: initialControlRunId,
                requestedDistributedRunId: initialDistributedRunId,
                availableControlRunIds: snapshot.runs.map(run => run.runId),
                distributedRuns,
            })
            : undefined,
        [
            distributedRuns,
            initialControlRunId,
            initialDistributedRunId,
            snapshot,
        ],
    );
    const diagnosticSelectionIssue = diagnosticSelection?.issue;

    useEffect(() => {
        if (!diagnosticSelectionIssue || !diagnosticSelection) {
            return;
        }
        setSelectedRunId(diagnosticSelection.controlRunId);
        setRun(current =>
            current?.runId === diagnosticSelection.controlRunId
                ? current
                : undefined);
        setSelectedDistributedRun(undefined);
        setArtifactBundle(undefined);
    }, [
        diagnosticSelection,
        diagnosticSelectionIssue,
        run,
        selectedDistributedRun,
        selectedRunId,
    ]);

    return {
        baseUrl,
        setBaseUrl,
        token,
        setToken,
        selectedRunId,
        setSelectedRunId,
        snapshot,
        setSnapshot,
        run,
        setRun,
        distributedRuns,
        setDistributedRuns,
        selectedDistributedRun,
        setSelectedDistributedRun,
        targetResolutionPreview,
        setTargetResolutionPreview,
        artifactBundle,
        setArtifactBundle,
        busyAction,
        setBusyAction,
        error,
        setError,
        lastAction,
        setLastAction,
        runOptions,
        currentDistributedRuns,
        selectedMonitor,
        redactedError,
        diagnosticSelectionIssue,
    };
}

export type DistributedRecipesRemoteStateModel =
    ReturnType<typeof useDistributedRecipesRemoteState>;
