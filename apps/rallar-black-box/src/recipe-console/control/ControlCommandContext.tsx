import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { OperationalStatus } from '../ui/StatusMark.tsx';
import { CommandBarItem } from '../ui/CommandBarItem.tsx';
import type { ControlQuerySnapshot } from './control-query.ts';
import type {
    RecipeConsoleActiveRunContext,
    RecipeConsoleControlSelection,
} from './control-selection.ts';

export function controlCommandStatus(
    query: ControlQuerySnapshot<ControlServerSnapshot>,
): Readonly<{ status: OperationalStatus; label: string }> {
    switch (query.status) {
        case 'connecting':
            return { status: 'running', label: `Connecting · ${query.reachability}` };
        case 'live':
            return { status: 'passed', label: `Live · ${query.reachability}` };
        case 'partial':
            return query.authorization === 'required'
                ? {
                    status: 'warning',
                    label: `Authorization required · ${query.reachability} · partial`,
                }
                : { status: 'partial', label: `Partial · ${query.reachability}` };
        case 'stale':
            return query.authorization === 'required'
                ? {
                    status: 'warning',
                    label: `Authorization required · ${query.reachability} · stale`,
                }
                : { status: 'stale', label: `Stale · ${query.reachability}` };
        case 'offline':
            if (query.authorization === 'required') {
                return {
                    status: 'warning',
                    label: `Authorization required · ${query.reachability}`,
                };
            }
            return query.reachability === 'reachable'
                ? { status: 'warning', label: 'Control error · reachable' }
                : { status: 'failed', label: `Offline · ${query.reachability}` };
    }
}

export function controlCommandActiveRunLabel(
    context: RecipeConsoleActiveRunContext,
    queryStatus: ControlQuerySnapshot<ControlServerSnapshot>['status'],
    distributedRunContextAvailable: boolean,
    controlRunContextAvailable = true,
): string {
    if (!distributedRunContextAvailable || !controlRunContextAvailable) {
        return 'Unknown';
    }
    const lastKnown = queryStatus === 'stale' ? ' · last known' : '';
    if (context.kind === 'sole') {
        const run = context.runs[0];
        return `${run.distributedRunId} · ${run.state}${lastKnown}`;
    }
    if (context.kind === 'ambiguous') {
        return `${context.runs.length} active${lastKnown}`;
    }
    return `None${lastKnown}`;
}

export function ControlCommandContext({
    baseUrl,
    query,
    safeTargetLabel,
    selection,
}: Readonly<{
    baseUrl: string;
    query: ControlQuerySnapshot<ControlServerSnapshot>;
    safeTargetLabel?: string;
    selection: RecipeConsoleControlSelection;
}>) {
    const connected = selection.boardRows.filter(row => row.connected).length;
    const controlRunContextAvailable = selection.controlRun !== undefined ||
        query.snapshot?.runs.length === 0;
    const connectedLabel = query.snapshot === undefined || !controlRunContextAvailable
        ? 'Unknown'
        : query.status === 'stale'
        ? `${connected}/${selection.boardRows.length} last known`
        : `${connected}/${selection.boardRows.length}`;
    const activeLabel = controlCommandActiveRunLabel(
        selection.activeRunContext,
        query.status,
        query.snapshot?.distributedRuns !== undefined,
        controlRunContextAvailable,
    );
    const safeLabel = controlCommandSafeTargetLabel({
        queryStatus: query.status,
        safeTargetableCount: selection.safeTargetableCount,
        lastKnownTargetableCount: selection.lastKnownTargetableCount,
        override: safeTargetLabel,
    });

    return (
        <>
            <CommandBarItem label="Control server">{baseUrl}</CommandBarItem>
            <CommandBarItem label="Control run">{selection.controlRunId ?? 'Select run'}</CommandBarItem>
            <CommandBarItem label="Group">{formatGroup(selection.groupContext.group)}</CommandBarItem>
            <CommandBarItem label="Connected">{connectedLabel}</CommandBarItem>
            <CommandBarItem label="Safe targets">{safeLabel}</CommandBarItem>
            <CommandBarItem label="Active run">{activeLabel}</CommandBarItem>
            <CommandBarItem label="Last updated">{formatLastUpdated(query.receivedAtEpochMs)}</CommandBarItem>
        </>
    );
}

export function controlCommandSafeTargetLabel(input: Readonly<{
    queryStatus: ControlQuerySnapshot<ControlServerSnapshot>['status'];
    safeTargetableCount: number;
    lastKnownTargetableCount: number;
    override?: string;
}>): string {
    if (input.override) return input.override;
    return input.queryStatus === 'stale'
        ? `0 current · ${input.lastKnownTargetableCount} last known`
        : String(input.safeTargetableCount);
}

function formatGroup(group: Readonly<{
    applicationId: string;
    workspaceId: string;
    groupId: string;
}>): string {
    return `${group.applicationId}/${group.workspaceId}/${group.groupId}`;
}

function formatLastUpdated(value: number | undefined): string {
    return value === undefined ? 'Never' : `${new Date(value).toISOString().slice(11, 19)}Z`;
}
