import type { DistributedRecipeTargetRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import {
    navigateReservedBrowserAgentPopups,
    releaseReservedBrowserAgentPopups,
    reserveBrowserAgentPopups,
    type BrowserAgentPopupReservation,
} from '../../browser-agent-popup.ts';
import { runnerAgentId, runnerNewAgentLaunchSuffix } from '../../runner-agent-launch.ts';
import { executeAgentLaunchBlocker } from './execute-agent-launch-blocker.ts';
import {
    executeAgentLaunchErrorMessage,
    executeAgentLaunchRunIdSync,
    mergeExecuteAgentLaunchCohort,
    sameExecuteAgentIds,
    type ExecuteAgentLaunchCohort,
} from './execute-agent-launch-state.ts';
import { useExecuteAgentCohort } from './use-execute-agent-cohort.ts';
export function useExecuteAgentLaunch(input: Readonly<{
    connection: RecipeConsoleControlConnection;
    controlRunId?: string;
    group: RallarBlackBoxDistributedGroupRef;
    targetRows: readonly DistributedRecipeTargetRow[];
    selectedAgentIds: readonly string[];
    selectionLocked: boolean;
    onBindRunId(runId: string): void;
    onSelectTargets(agentIds: readonly string[]): void;
}>) {
    const [expanded, setExpanded] = useState(false);
    const [runId, setRunIdState] = useState(
        () => input.controlRunId ?? input.connection.bootstrap.bootstrapRunId ?? '',
    );
    const [prefix, setPrefixState] = useState('browser-agent');
    const [count, setCountState] = useState(3);
    const [suffix, setSuffix] = useState(() => runnerNewAgentLaunchSuffix());
    const [busyAction, setBusyAction] = useState<'open' | 'copy'>();
    const [message, setMessage] = useState<string>();
    const [blockedAgentIds, setBlockedAgentIds] = useState<readonly string[]>([]);
    const [cohort, setCohort] = useState<ExecuteAgentLaunchCohort>();
    const [pendingCohort, setPendingCohort] = useState<ExecuteAgentLaunchCohort>();
    const runIdRef = useRef(runId);
    const selectedControlRunIdRef = useRef(input.controlRunId);
    const requestRef = useRef<AbortController | undefined>(undefined);
    const reservationRef = useRef<BrowserAgentPopupReservation | undefined>(undefined);
    const generationRef = useRef(0);
    const autoExpansionDecidedRef = useRef(false);
    const launchContextKey = JSON.stringify([
        input.connection.baseUrl,
        input.connection.bootstrap.apiBaseUrl,
        input.connection.bootstrap.providerMode,
        input.group,
    ]);
    const launchContextKeyRef = useRef(launchContextKey);

    const agentIds = useMemo(
        () => Array.from({ length: count }, (_, index) =>
            runnerAgentId(prefix, index, count, suffix)
        ),
        [count, prefix, suffix],
    );
    const blocker = executeAgentLaunchBlocker({
        connection: input.connection,
        group: input.group,
        runId,
        prefix,
        count,
    });
    const cohortState = useExecuteAgentCohort({
        cohort,
        pendingCohort,
        targetRows: input.targetRows,
        selectedAgentIds: input.selectedAgentIds,
        selectionLocked: input.selectionLocked,
        controlRunId: input.controlRunId,
        onSelectTargets: input.onSelectTargets,
        onReadyMessage: setMessage,
    });
    runIdRef.current = runId;

    useEffect(() => {
        const sync = executeAgentLaunchRunIdSync({
            previousControlRunId: selectedControlRunIdRef.current,
            nextControlRunId: input.controlRunId,
            currentRunId: runIdRef.current,
        });
        if (!sync) return;
        selectedControlRunIdRef.current = sync.selectedControlRunId;
        if (!sync.runId) return;
        if (sync.invalidate) {
            invalidateLaunchContext('The selected control run changed before launch completed.');
            setMessage(undefined);
        }
        runIdRef.current = sync.runId;
        setRunIdState(sync.runId);
    }, [input.controlRunId]);
    useEffect(() => {
        if (launchContextKeyRef.current === launchContextKey) return;
        launchContextKeyRef.current = launchContextKey;
        invalidateLaunchContext('Browser-agent launch context changed before launch completed.');
        setMessage(undefined);
    }, [launchContextKey]);
    useEffect(() => {
        if (
            autoExpansionDecidedRef.current ||
            input.connection.query.status === 'connecting'
        ) return;
        autoExpansionDecidedRef.current = true;
        if (
            !input.controlRunId ||
            input.targetRows.every(row => !row.targetable)
        ) {
            setExpanded(true);
        }
    }, [
        input.connection.query.status,
        input.controlRunId,
        input.targetRows,
    ]);
    useEffect(() => () => disposePending('Browser-agent launch was cancelled.'), []);

    function disposePending(reason: string): void {
        generationRef.current += 1;
        requestRef.current?.abort();
        requestRef.current = undefined;
        if (reservationRef.current) {
            releaseReservedBrowserAgentPopups(reservationRef.current, reason);
            reservationRef.current = undefined;
        }
    }

    function invalidatePending(reason: string): void {
        disposePending(reason);
        setPendingCohort(undefined);
        setBusyAction(undefined);
    }

    function invalidateLaunchContext(reason: string): void {
        invalidatePending(reason);
        setCohort(undefined);
        setBlockedAgentIds([]);
    }

    function setRunId(value: string): void {
        invalidateLaunchContext('Control run ID changed before launch completed.');
        runIdRef.current = value;
        setRunIdState(value);
        setMessage(undefined);
    }

    function setPrefix(value: string): void {
        invalidatePending('Agent ID prefix changed before launch completed.');
        setPrefixState(value);
        setMessage(undefined);
    }

    function setCount(value: number): void {
        invalidatePending('Agent count changed before launch completed.');
        setCountState(value);
        setMessage(undefined);
    }

    function openAgents(): 'blocked' | 'reserved' | undefined {
        if (blocker || busyAction) return;
        const reservation = reserveBrowserAgentPopups(agentIds);
        setBlockedAgentIds(reservation.blockedAgentIds);
        if (reservation.reservedAgentIds.length === 0) {
            setMessage(
                `Your browser blocked all ${agentIds.length} agent tabs. Copy the launch links instead.`,
            );
            return 'blocked';
        }
        reservationRef.current = reservation;
        void prepareReserved(reservation);
        return 'reserved';
    }

    async function prepareReserved(
        reservation: BrowserAgentPopupReservation,
    ): Promise<void> {
        const service = input.connection.browserAgentLaunch;
        if (!service) return;
        const generation = ++generationRef.current;
        const controller = new AbortController();
        requestRef.current = controller;
        setPendingCohort({ runId: runId.trim(), agentIds: [...reservation.reservedAgentIds].sort() });
        setBusyAction('open');
        setMessage(`Preparing ${reservation.reservedAgentIds.length} browser agent ${reservation.reservedAgentIds.length === 1 ? 'session' : 'sessions'}…`);
        input.onBindRunId(runId.trim());
        try {
            const prepared = await service.prepare({
                runId,
                agentIds: reservation.reservedAgentIds,
                group: input.group,
                signal: controller.signal,
            });
            if (generationRef.current !== generation || controller.signal.aborted) return;
            navigateReservedBrowserAgentPopups(reservation, prepared.agents);
            reservationRef.current = undefined;
            setCohort({
                runId: prepared.runId,
                agentIds: prepared.agents.map(agent => agent.agentId),
            });
            const blocked = reservation.blockedAgentIds.length;
            setMessage(blocked > 0
                ? `Opened ${prepared.agents.length} agent tabs. ${blocked} ${blocked === 1 ? 'tab was' : 'tabs were'} blocked; use the copy-link fallback below.`
                : `Opened ${prepared.agents.length} browser agent ${prepared.agents.length === 1 ? 'tab' : 'tabs'}. Waiting for registration.`,
            );
            setSuffix(runnerNewAgentLaunchSuffix());
            await input.connection.refreshAfterCurrent();
        } catch (error) {
            if (!controller.signal.aborted && generationRef.current === generation) {
                releaseReservedBrowserAgentPopups(
                    reservation,
                    executeAgentLaunchErrorMessage(error),
                );
                reservationRef.current = undefined;
                setMessage(executeAgentLaunchErrorMessage(error));
            }
        } finally {
            if (requestRef.current === controller) requestRef.current = undefined;
            if (generationRef.current === generation) {
                setPendingCohort(undefined);
                setBusyAction(undefined);
            }
        }
    }

    async function copyAgents(ids: readonly string[]): Promise<void> {
        const service = input.connection.browserAgentLaunch;
        if (blocker || !service || busyAction) return;
        const replaceCohort = sameExecuteAgentIds(ids, agentIds);
        const generation = ++generationRef.current;
        const controller = new AbortController();
        requestRef.current = controller;
        setPendingCohort(mergeExecuteAgentLaunchCohort(
            replaceCohort ? undefined : cohort,
            runId.trim(),
            ids,
        ));
        setBusyAction('copy');
        input.onBindRunId(runId.trim());
        setMessage(`Preparing ${ids.length} fresh launch ${ids.length === 1 ? 'link' : 'links'}…`);
        try {
            const prepared = await service.prepare({
                runId,
                agentIds: ids,
                group: input.group,
                signal: controller.signal,
            });
            if (generationRef.current !== generation || controller.signal.aborted) return;
            await navigator.clipboard.writeText(
                prepared.agents.map(agent => agent.launchUrl).join('\n'),
            );
            setCohort(previous => mergeExecuteAgentLaunchCohort(
                replaceCohort ? undefined : previous,
                prepared.runId,
                prepared.agents.map(agent => agent.agentId),
            ));
            setMessage(
                `Copied ${prepared.agents.length} fresh, short-lived launch ${prepared.agents.length === 1 ? 'link' : 'links'}.`,
            );
            if (ids.length === agentIds.length) setSuffix(runnerNewAgentLaunchSuffix());
            await input.connection.refreshAfterCurrent();
        } catch (error) {
            if (!controller.signal.aborted && generationRef.current === generation) {
                setMessage(executeAgentLaunchErrorMessage(error));
            }
        } finally {
            if (requestRef.current === controller) requestRef.current = undefined;
            if (generationRef.current === generation) {
                setPendingCohort(undefined);
                setBusyAction(undefined);
            }
        }
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
        blockedAgentIds,
        busyAction,
        blocker,
        message,
        ...cohortState,
        openAgents,
        copyAgentLinks: () => copyAgents(agentIds),
        copyAgentLink: (agentId: string) => copyAgents([agentId]),
    } as const;
}
export type ExecuteAgentLaunchModel = ReturnType<typeof useExecuteAgentLaunch>;
