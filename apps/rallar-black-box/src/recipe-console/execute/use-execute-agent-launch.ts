import type { DistributedRecipeTargetRow } from
    '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import {
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { RecipeConsoleControlConnection } from
    '../control/ControlConnectionProvider.tsx';
import {
    navigateReservedBrowserAgentPopups,
    releaseReservedBrowserAgentPopups,
    reserveBrowserAgentPopups,
    type BrowserAgentPopupReservation,
} from '../../browser-agent-popup.ts';
import {
    runnerAgentId,
    runnerNewAgentLaunchSuffix,
} from '../../runner-agent-launch.ts';
import { executeAgentLaunchBlocker } from './execute-agent-launch-blocker.ts';
type SanitizedCohort = Readonly<{
    runId: string;
    agentIds: readonly string[];
}>;

export function useExecuteAgentLaunch(input: Readonly<{
    connection: RecipeConsoleControlConnection;
    controlRunId?: string;
    targetRows: readonly DistributedRecipeTargetRow[];
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
    const [cohort, setCohort] = useState<SanitizedCohort>();
    const requestRef = useRef<AbortController | undefined>(undefined);
    const reservationRef = useRef<BrowserAgentPopupReservation | undefined>(undefined);
    const generationRef = useRef(0);
    const announcedRef = useRef<string | undefined>(undefined);
    const autoExpansionDecidedRef = useRef(false);
    const launchContextKey = JSON.stringify([
        input.connection.baseUrl,
        input.connection.bootstrap.apiBaseUrl,
        input.connection.bootstrap.providerMode,
        input.connection.bootstrap.bootstrapGroup,
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
        runId,
        prefix,
        count,
    });
    const readyAgentIds = useMemo(() => {
        if (!cohort) return [];
        const targetable = new Set(
            input.targetRows.filter(row => row.targetable).map(row => row.agentId),
        );
        return cohort.agentIds.filter(agentId => targetable.has(agentId));
    }, [cohort, input.targetRows]);

    useEffect(() => {
        if (!input.controlRunId || input.controlRunId === runId) return;
        invalidatePending('The selected control run changed before launch completed.');
        setRunIdState(input.controlRunId);
        setMessage(undefined);
    }, [input.controlRunId, runId]);
    useEffect(() => {
        if (launchContextKeyRef.current === launchContextKey) return;
        launchContextKeyRef.current = launchContextKey;
        invalidatePending('Browser-agent launch context changed before launch completed.');
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
    useEffect(() => () => invalidatePending('Browser-agent launch was cancelled.'), []);
    useEffect(() => {
        if (
            !cohort || input.selectionLocked ||
            input.controlRunId !== cohort.runId ||
            readyAgentIds.length !== cohort.agentIds.length
        ) return;
        const key = JSON.stringify([cohort.runId, cohort.agentIds]);
        if (announcedRef.current === key) return;
        announcedRef.current = key;
        input.onSelectTargets(cohort.agentIds);
        setMessage(
            `${cohort.agentIds.length} launched browser ${cohort.agentIds.length === 1 ? 'agent is' : 'agents are'} ready and selected as targets.`,
        );
    }, [
        cohort,
        input.controlRunId,
        input.onSelectTargets,
        input.selectionLocked,
        readyAgentIds.length,
    ]);

    function invalidatePending(reason: string): void {
        generationRef.current += 1;
        requestRef.current?.abort();
        requestRef.current = undefined;
        if (reservationRef.current) {
            releaseReservedBrowserAgentPopups(reservationRef.current, reason);
            reservationRef.current = undefined;
        }
    }

    function setRunId(value: string): void {
        invalidatePending('Control run ID changed before launch completed.');
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

    function openAgents(): void {
        if (blocker || busyAction) return;
        const reservation = reserveBrowserAgentPopups(agentIds);
        setBlockedAgentIds(reservation.blockedAgentIds);
        if (reservation.reservedAgentIds.length === 0) {
            setMessage(
                `Your browser blocked all ${agentIds.length} agent tabs. Copy the launch links instead.`,
            );
            return;
        }
        reservationRef.current = reservation;
        void prepareReserved(reservation);
    }

    async function prepareReserved(
        reservation: BrowserAgentPopupReservation,
    ): Promise<void> {
        const service = input.connection.browserAgentLaunch;
        if (!service) return;
        const generation = ++generationRef.current;
        const controller = new AbortController();
        requestRef.current = controller;
        setBusyAction('open');
        setMessage(`Preparing ${reservation.reservedAgentIds.length} browser agent ${reservation.reservedAgentIds.length === 1 ? 'session' : 'sessions'}…`);
        input.onBindRunId(runId.trim());
        try {
            const prepared = await service.prepare({
                runId,
                agentIds: reservation.reservedAgentIds,
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
                releaseReservedBrowserAgentPopups(reservation, errorMessage(error));
                reservationRef.current = undefined;
                setMessage(errorMessage(error));
            }
        } finally {
            if (requestRef.current === controller) requestRef.current = undefined;
            if (generationRef.current === generation) setBusyAction(undefined);
        }
    }

    async function copyAgents(ids: readonly string[]): Promise<void> {
        const service = input.connection.browserAgentLaunch;
        if (blocker || !service || busyAction) return;
        const generation = ++generationRef.current;
        const controller = new AbortController();
        requestRef.current = controller;
        setBusyAction('copy');
        input.onBindRunId(runId.trim());
        setMessage(`Preparing ${ids.length} fresh launch ${ids.length === 1 ? 'link' : 'links'}…`);
        try {
            const prepared = await service.prepare({
                runId,
                agentIds: ids,
                signal: controller.signal,
            });
            if (generationRef.current !== generation || controller.signal.aborted) return;
            await navigator.clipboard.writeText(
                prepared.agents.map(agent => agent.launchUrl).join('\n'),
            );
            setCohort(previous => ({
                runId: prepared.runId,
                agentIds: [...new Set([
                    ...(previous?.runId === prepared.runId ? previous.agentIds : []),
                    ...prepared.agents.map(agent => agent.agentId),
                ])].sort(),
            }));
            setMessage(
                `Copied ${prepared.agents.length} fresh, short-lived launch ${prepared.agents.length === 1 ? 'link' : 'links'}.`,
            );
            if (ids.length === agentIds.length) setSuffix(runnerNewAgentLaunchSuffix());
            await input.connection.refreshAfterCurrent();
        } catch (error) {
            if (!controller.signal.aborted && generationRef.current === generation) {
                setMessage(errorMessage(error));
            }
        } finally {
            if (requestRef.current === controller) requestRef.current = undefined;
            if (generationRef.current === generation) setBusyAction(undefined);
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
        agentIds,
        blockedAgentIds,
        busyAction,
        blocker,
        message,
        launchedExpectedCount: cohort?.agentIds.length ?? 0,
        launchedReadyCount: readyAgentIds.length,
        openAgents,
        copyAgentLinks: () => copyAgents(agentIds),
        copyAgentLink: (agentId: string) => copyAgents([agentId]),
    } as const;
}
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
export type ExecuteAgentLaunchModel = ReturnType<typeof useExecuteAgentLaunch>;
