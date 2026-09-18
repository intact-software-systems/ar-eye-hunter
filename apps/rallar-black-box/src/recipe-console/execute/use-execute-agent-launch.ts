import type { DistributedRecipeTargetRow } from '@shared-test/rallar-bb-test/distributed-recipe-targeting/distributed-recipe-target-contracts.ts';
import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { runnerAgentId, runnerNewAgentLaunchSuffix } from '../../runner-agent-launch.ts';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import { executeAgentLaunchBlocker } from './execute-agent-launch-blocker.ts';
import { executeAgentLaunchRunIdSync } from './execute-agent-launch-state.ts';
import { useExecuteAgentCohort } from './use-execute-agent-cohort.ts';
import { useExecuteAgentLaunchRequests } from './use-execute-agent-launch-requests.ts';

export function useExecuteAgentLaunch(
    input: Readonly<{
        connection: RecipeConsoleControlConnection;
        /** Absent while no control run is selected. */
        controlRunId?: string;
        group: RallarBlackBoxDistributedGroupRef;
        targetRows: readonly DistributedRecipeTargetRow[];
        selectedAgentIds: readonly string[];
        selectionLocked: boolean;
        onBindRunId(runId: string): void;
        onSelectTargets(agentIds: readonly string[]): void;
    }>
) {
    const [expanded, setExpanded] = useState(false);
    const [runId, setRunIdState] = useState(
        () => input.controlRunId ?? input.connection.bootstrap.bootstrapRunId ?? ''
    );
    const [prefix, setPrefixState] = useState('browser-agent');
    const [count, setCountState] = useState(3);
    const [suffix, setSuffix] = useState(() => runnerNewAgentLaunchSuffix());
    const runIdRef = useRef(runId);
    const selectedControlRunIdRef = useRef(input.controlRunId);
    const autoExpansionDecidedRef = useRef(false);
    const launchContextKey = JSON.stringify([
        input.connection.baseUrl,
        input.connection.bootstrap.apiBaseUrl,
        input.connection.bootstrap.providerMode,
        input.group
    ]);
    const launchContextKeyRef = useRef(launchContextKey);
    const agentIds = useMemo(
        () => Array.from({ length: count }, (_, index) => runnerAgentId(prefix, index, count, suffix)),
        [count, prefix, suffix]
    );
    const blocker = executeAgentLaunchBlocker({
        connection: input.connection,
        group: input.group,
        runId,
        prefix,
        count
    });
    const requests = useExecuteAgentLaunchRequests({
        connection: input.connection,
        group: input.group,
        agentIds,
        blocker,
        runId,
        onBindRunId: input.onBindRunId,
        onLaunchSuffixConsumed: () => setSuffix(runnerNewAgentLaunchSuffix())
    });
    const cohortState = useExecuteAgentCohort({
        cohort: requests.cohort,
        pendingCohort: requests.pendingCohort,
        targetRows: input.targetRows,
        selectedAgentIds: input.selectedAgentIds,
        selectionLocked: input.selectionLocked,
        controlRunId: input.controlRunId,
        onSelectTargets: input.onSelectTargets,
        onReadyMessage: requests.setMessage
    });
    runIdRef.current = runId;
    useEffect(() => {
        const sync = executeAgentLaunchRunIdSync({
            previousControlRunId: selectedControlRunIdRef.current,
            nextControlRunId: input.controlRunId,
            currentRunId: runIdRef.current
        });
        if (!sync) {
            return;
        }
        selectedControlRunIdRef.current = sync.selectedControlRunId;
        if (!sync.runId) {
            return;
        }
        if (sync.invalidate) {
            requests.resetLaunchContext('The selected control run changed before launch completed.');
            requests.setMessage(undefined);
        }
        runIdRef.current = sync.runId;
        setRunIdState(sync.runId);
    }, [input.controlRunId]);
    useEffect(() => {
        if (launchContextKeyRef.current === launchContextKey) {
            return;
        }
        launchContextKeyRef.current = launchContextKey;
        requests.resetLaunchContext('Browser-agent launch context changed before launch completed.');
        requests.setMessage(undefined);
    }, [launchContextKey]);
    useEffect(() => {
        if (
            autoExpansionDecidedRef.current ||
            input.connection.query.status === 'connecting'
        ) {
            return;
        }
        autoExpansionDecidedRef.current = true;
        if (
            !input.controlRunId ||
            input.targetRows.every((row) => !row.targetable)
        ) {
            setExpanded(true);
        }
    }, [
        input.connection.query.status,
        input.controlRunId,
        input.targetRows
    ]);

    function setRunId(value: string): void {
        requests.resetLaunchContext('Control run ID changed before launch completed.');
        runIdRef.current = value;
        setRunIdState(value);
        requests.setMessage(undefined);
    }

    function setPrefix(value: string): void {
        requests.resetPendingLaunch('Agent ID prefix changed before launch completed.');
        setPrefixState(value);
        requests.setMessage(undefined);
    }

    function setCount(value: number): void {
        requests.resetPendingLaunch('Agent count changed before launch completed.');
        setCountState(value);
        requests.setMessage(undefined);
    }

    return {
        expanded,
        setExpanded,
        runId,
        setRunId,
        prefix,
        setPrefix,
        count,
        setCount,
        group: input.group,
        agentIds,
        blockedAgentIds: requests.blockedAgentIds,
        busyAction: requests.busyAction,
        blocker,
        message: requests.message,
        ...cohortState,
        openAgents: requests.openAgents,
        copyAgentLinks: () => requests.writeAgentLaunchLinksToClipboard(agentIds),
        copyAgentLink: (agentId: string) => requests.writeAgentLaunchLinksToClipboard([agentId])
    } as const;
}

export type ExecuteAgentLaunchModel = ReturnType<typeof useExecuteAgentLaunch>;
