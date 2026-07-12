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
            return { status: 'partial', label: `Partial · ${query.reachability}` };
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
): string {
    if (context.kind === 'sole') {
        const run = context.runs[0];
        return `${run.distributedRunId} · ${run.state}`;
    }
    if (context.kind === 'ambiguous') {
        return `${context.runs.length} active`;
    }
    return queryStatus === 'partial' ? 'Unknown' : 'None';
}

export function ControlCommandContext({
    baseUrl,
    query,
    selection,
}: Readonly<{
    baseUrl: string;
    query: ControlQuerySnapshot<ControlServerSnapshot>;
    selection: RecipeConsoleControlSelection;
}>) {
    const connected = selection.boardRows.filter(row => row.connected).length;
    const connectedLabel = query.status === 'stale'
        ? `${connected}/${selection.boardRows.length} last known`
        : `${connected}/${selection.boardRows.length}`;
    const activeLabel = controlCommandActiveRunLabel(
        selection.activeRunContext,
        query.status,
    );
    const safeLabel = query.status === 'stale'
        ? `0 current · ${selection.lastKnownTargetableCount} last known`
        : String(selection.safeTargetableCount);

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
