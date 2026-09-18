import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { useEffect, useRef, useState } from 'react';
import {
    navigateReservedBrowserAgentPopups,
    releaseReservedBrowserAgentPopups,
    reserveBrowserAgentPopups,
    type BrowserAgentPopupReservation
} from '../../../browser-agent-popup.ts';
import type { RecipeConsoleControlConnection } from '../../control/ControlConnectionProvider.tsx';
import {
    computeExecuteAgentPopupNavigationState,
    computeMergedExecuteAgentLaunchCohort,
    isSameExecuteAgentIds,
    type ExecuteAgentLaunchCohort
} from './execute-agent-launch-state.ts';

export function useExecuteAgentLaunchRequests(
    input: Readonly<{
        connection: RecipeConsoleControlConnection;
        group: RallarBlackBoxDistributedGroupRef;
        agentIds: readonly string[];
        /** Absent while nothing blocks a launch from the current form. */
        blocker?: string;
        runId: string;
        onBindRunId(runId: string): void;
        onLaunchSuffixConsumed(): void;
    }>
) {
    const [busyAction, setBusyAction] = useState<'open' | 'copy'>();
    const [message, setMessage] = useState<string>();
    const [blockedAgentIds, setBlockedAgentIds] = useState<readonly string[]>([]);
    const [cohort, setCohort] = useState<ExecuteAgentLaunchCohort>();
    const [pendingCohort, setPendingCohort] = useState<ExecuteAgentLaunchCohort>();
    const requestRef = useRef<AbortController | undefined>(undefined);
    const reservationRef = useRef<BrowserAgentPopupReservation | undefined>(undefined);
    const generationRef = useRef(0);
    useEffect(() => () => stopPendingLaunch('Browser-agent launch was cancelled.'), []);

    function stopPendingLaunch(reason: string): void {
        generationRef.current += 1;
        requestRef.current?.abort();
        requestRef.current = undefined;
        if (reservationRef.current) {
            releaseReservedBrowserAgentPopups(reservationRef.current, reason);
            reservationRef.current = undefined;
        }
    }
    function resetPendingLaunch(reason: string): void {
        stopPendingLaunch(reason);
        setPendingCohort(undefined);
        setBusyAction(undefined);
    }
    function resetLaunchContext(reason: string): void {
        resetPendingLaunch(reason);
        setCohort(undefined);
        setBlockedAgentIds([]);
    }

    function openAgents(): 'blocked' | 'reserved' | undefined {
        if (input.blocker || busyAction) {
            return;
        }
        const reservation = reserveBrowserAgentPopups(input.agentIds);
        setBlockedAgentIds(reservation.blockedAgentIds);
        if (reservation.reservedAgentIds.length === 0) {
            setMessage(
                `Your browser blocked all ${input.agentIds.length} agent tabs. Copy the launch links instead.`
            );
            return 'blocked';
        }
        reservationRef.current = reservation;
        void startReservedAgentLaunch(reservation);
        return 'reserved';
    }

    async function startReservedAgentLaunch(
        reservation: BrowserAgentPopupReservation
    ): Promise<void> {
        const service = input.connection.browserAgentLaunch;
        if (!service) {
            return;
        }
        const generation = ++generationRef.current;
        const controller = new AbortController();
        requestRef.current = controller;
        setPendingCohort({ runId: input.runId.trim(), agentIds: [...reservation.reservedAgentIds].sort() });
        setBusyAction('open');
        setMessage(
            `Preparing ${reservation.reservedAgentIds.length} browser agent ${
                reservation.reservedAgentIds.length === 1 ? 'session' : 'sessions'
            }…`
        );
        input.onBindRunId(input.runId.trim());
        try {
            const prepared = await service.prepare({
                runId: input.runId,
                agentIds: reservation.reservedAgentIds,
                group: input.group,
                signal: controller.signal
            });
            if (generationRef.current !== generation || controller.signal.aborted) {
                return;
            }
            const navigation = navigateReservedBrowserAgentPopups(
                reservation,
                prepared.agents
            );
            reservationRef.current = undefined;
            const outcome = computeExecuteAgentPopupNavigationState({
                runId: prepared.runId,
                blockedAgentIds: reservation.blockedAgentIds,
                closedAgentIds: navigation.closedAgentIds,
                navigatedAgentIds: navigation.navigatedAgentIds
            });
            setBlockedAgentIds(outcome.unavailableAgentIds);
            setCohort(outcome.cohort);
            setMessage(outcome.message);
            input.onLaunchSuffixConsumed();
            await input.connection.refreshAfterCurrent();
        }
        catch (error) {
            if (!controller.signal.aborted && generationRef.current === generation) {
                releaseReservedBrowserAgentPopups(
                    reservation,
                    toError(error).message
                );
                reservationRef.current = undefined;
                setMessage(toError(error).message);
            }
        }
        finally {
            releaseRequest(controller, generation);
        }
    }

    async function writeAgentLaunchLinksToClipboard(ids: readonly string[]): Promise<void> {
        const service = input.connection.browserAgentLaunch;
        if (input.blocker || !service || busyAction) {
            return;
        }
        if (!navigator.clipboard?.writeText) {
            setMessage('Clipboard access is unavailable; open the agent tabs instead.');
            return;
        }
        const replaceCohort = isSameExecuteAgentIds(ids, input.agentIds);
        const generation = ++generationRef.current;
        const controller = new AbortController();
        requestRef.current = controller;
        setPendingCohort(computeMergedExecuteAgentLaunchCohort(
            replaceCohort ? undefined : cohort,
            input.runId.trim(),
            ids
        ));
        setBusyAction('copy');
        input.onBindRunId(input.runId.trim());
        setMessage(`Preparing ${ids.length} fresh launch ${ids.length === 1 ? 'link' : 'links'}…`);
        try {
            const prepared = await service.prepare({
                runId: input.runId,
                agentIds: ids,
                group: input.group,
                signal: controller.signal
            });
            if (generationRef.current !== generation || controller.signal.aborted) {
                return;
            }
            await navigator.clipboard.writeText(
                prepared.agents.map((agent) => agent.launchUrl).join('\n')
            );
            setCohort((previous) =>
                computeMergedExecuteAgentLaunchCohort(
                    replaceCohort ? undefined : previous,
                    prepared.runId,
                    prepared.agents.map((agent) => agent.agentId)
                )
            );
            setMessage(
                `Copied ${prepared.agents.length} fresh, short-lived launch ${
                    prepared.agents.length === 1 ? 'link' : 'links'
                }.`
            );
            if (ids.length === input.agentIds.length) {
                input.onLaunchSuffixConsumed();
            }
            await input.connection.refreshAfterCurrent();
        }
        catch (error) {
            if (!controller.signal.aborted && generationRef.current === generation) {
                setMessage(toError(error).message);
            }
        }
        finally {
            releaseRequest(controller, generation);
        }
    }

    function releaseRequest(controller: AbortController, generation: number): void {
        if (requestRef.current === controller) {
            requestRef.current = undefined;
        }
        if (generationRef.current === generation) {
            setPendingCohort(undefined);
            setBusyAction(undefined);
        }
    }

    return {
        blockedAgentIds,
        busyAction,
        cohort,
        message,
        pendingCohort,
        openAgents,
        resetLaunchContext,
        resetPendingLaunch,
        setMessage,
        writeAgentLaunchLinksToClipboard
    } as const;
}
