import type { RallarServerWorkbenchVariables } from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import type { RtcMembershipDiagnostics } from '../../../rtc-diagnostics.ts';
import type {
    ClientStateRow,
    RoomsClientsDraftModel,
    RoomsClientsRows,
    RoomStateRow
} from './rooms-clients-contracts.ts';
import {
    rowsFromClientSnapshots,
    rowsFromGroupSnapshots,
    rowsFromStateEvents,
    sortClientRows,
    sortGroupRows
} from './rooms-clients-derivations.ts';

export interface RoomsClientsStateBodies {
    readonly groupsBody: unknown;
    readonly clientsBody: unknown;
    readonly groupEventsBody: unknown;
    readonly clientEventsBody: unknown;
}

export interface RoomsClientsRowsSource {
    readonly bodies: RoomsClientsStateBodies;
    readonly draft: Pick<
        RoomsClientsDraftModel,
        'variables' | 'onlyGroupsWithMembers' | 'onlyOnlineClients' | 'groupSort' | 'clientSort' | 'expectedOtherClient'
    >;
    readonly membership: RtcMembershipDiagnostics;
}

const STATE_EVENT_ROW_LIMIT = 32;

export function toRoomsClientsRows({ bodies, draft, membership }: RoomsClientsRowsSource): RoomsClientsRows {
    const groupRows = rowsFromGroupSnapshots(bodies.groupsBody);
    const clientRows = rowsFromClientSnapshots(bodies.clientsBody);
    const visibleGroupRows = draft.onlyGroupsWithMembers ? groupRows.filter((row) => row.members > 0) : groupRows;
    const visibleClientRows = draft.onlyOnlineClients ? clientRows.filter(isClientOnline) : clientRows;
    const currentSessionInGroup = isSessionInActiveGroup(groupRows, draft.variables);
    return {
        groupRows,
        clientRows,
        visibleGroupRows,
        visibleClientRows,
        sortedGroupRows: sortGroupRows(visibleGroupRows, draft.groupSort),
        sortedClientRows: sortClientRows(visibleClientRows, draft.clientSort),
        stateEvents: [...rowsFromStateEvents(bodies.groupEventsBody), ...rowsFromStateEvents(bodies.clientEventsBody)]
            .slice(-STATE_EVENT_ROW_LIMIT)
            .reverse(),
        expectedClients: membership.expectedClients,
        observedClients: membership.observedClients,
        missingClients: membership.expectedClients.filter((client) => !membership.observedClients.includes(client)),
        currentSessionInGroup,
        currentClientOnline: isCurrentClientOnline(clientRows, draft.variables) || currentSessionInGroup,
        expectedOtherClientVisible: isExpectedClientVisible(clientRows, draft.expectedOtherClient)
    };
}

function isClientOnline(row: ClientStateRow): boolean {
    return row.online === 'online' || row.sessions.length > 0;
}

function isSessionInActiveGroup(
    groupRows: readonly RoomStateRow[],
    variables: RallarServerWorkbenchVariables
): boolean {
    const activeGroupRow = groupRows.find((row) =>
        row.groupId === variables.groupId || row.displayName === variables.groupId
    );
    return Boolean(variables.sessionId && activeGroupRow?.sessions.includes(variables.sessionId));
}

function isCurrentClientOnline(
    clientRows: readonly ClientStateRow[],
    variables: RallarServerWorkbenchVariables
): boolean {
    const currentClientRow = clientRows.find((row) =>
        row.principalId === variables.principalId ||
        row.username === variables.username ||
        row.sessions.includes(variables.sessionId)
    );
    return currentClientRow?.online === 'online' || (currentClientRow?.sessions.length ?? 0) > 0;
}

function isExpectedClientVisible(clientRows: readonly ClientStateRow[], expectedClient: string): boolean {
    const needle = expectedClient.trim().toLowerCase();
    return needle.length > 0 &&
        clientRows.some((row) =>
            [row.principalId, row.username, ...row.sessions].some((value) => value.toLowerCase().includes(needle)) &&
            isClientOnline(row)
        );
}
