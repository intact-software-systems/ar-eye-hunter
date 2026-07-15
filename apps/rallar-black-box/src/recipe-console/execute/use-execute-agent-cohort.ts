import type { DistributedRecipeTargetRow } from
    '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    readyExecuteAgentIds,
    sameExecuteAgentIds,
    type ExecuteAgentLaunchCohort,
} from './execute-agent-launch-state.ts';

export function useExecuteAgentCohort(input: Readonly<{
    cohort?: ExecuteAgentLaunchCohort;
    pendingCohort?: ExecuteAgentLaunchCohort;
    targetRows: readonly DistributedRecipeTargetRow[];
    selectedAgentIds: readonly string[];
    selectionLocked: boolean;
    controlRunId?: string;
    onSelectTargets(agentIds: readonly string[]): void;
    onReadyMessage(message: string): void;
}>) {
    const [reconciledKey, setReconciledKey] = useState<string | undefined>(undefined);
    const requestedKeyRef = useRef<string | undefined>(undefined);
    const activeCohort = input.pendingCohort ?? input.cohort;
    const activeReadyAgentIds = useMemo(
        () => readyExecuteAgentIds(activeCohort, input.targetRows),
        [activeCohort, input.targetRows],
    );
    const readyAgentIds = useMemo(
        () => readyExecuteAgentIds(input.cohort, input.targetRows),
        [input.cohort, input.targetRows],
    );
    const cohortKey = executeAgentCohortKey(input.cohort);
    const cohortSelected = Boolean(input.cohort && sameExecuteAgentIds(
        input.cohort.agentIds,
        input.selectedAgentIds,
    ));

    useEffect(() => {
        const cohort = input.cohort;
        if (!cohort || !cohortKey) {
            requestedKeyRef.current = undefined;
            setReconciledKey(undefined);
            return;
        }
        if (
            readyAgentIds.length !== cohort.agentIds.length ||
            reconciledKey === cohortKey
        ) return;
        if (cohortSelected) {
            setReconciledKey(cohortKey);
            input.onReadyMessage(
                `${cohort.agentIds.length} launched browser ${cohort.agentIds.length === 1 ? 'agent is' : 'agents are'} ready and selected as targets.`,
            );
            return;
        }
        if (
            input.selectionLocked || input.controlRunId !== cohort.runId ||
            requestedKeyRef.current === cohortKey
        ) return;
        requestedKeyRef.current = cohortKey;
        input.onSelectTargets(cohort.agentIds);
    }, [
        cohortKey,
        cohortSelected,
        input.cohort,
        input.controlRunId,
        input.onReadyMessage,
        input.onSelectTargets,
        input.selectionLocked,
        readyAgentIds.length,
        reconciledKey,
    ]);

    return {
        launchedExpectedCount: activeCohort?.agentIds.length ?? 0,
        launchedReadyCount: activeReadyAgentIds.length,
        launchPreparationPending: input.pendingCohort !== undefined,
        launchedCohortSelectionPending: Boolean(
            input.cohort && readyAgentIds.length === input.cohort.agentIds.length &&
            reconciledKey !== cohortKey
        ),
    } as const;
}

function executeAgentCohortKey(
    cohort: ExecuteAgentLaunchCohort | undefined,
): string | undefined {
    return cohort
        ? JSON.stringify([cohort.runId, cohort.agentIds])
        : undefined;
}
