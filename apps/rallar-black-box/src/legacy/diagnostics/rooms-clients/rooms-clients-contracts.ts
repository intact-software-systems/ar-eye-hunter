import type { RallarServerWorkbenchVariables } from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import type { CommandCenterActionFeedback } from '../shared/action-feedback.ts';
import type { CommandCenterRestActionLog } from '../shared/to-rest-action-log-entry.ts';

export type RoomsClientsActionId =
    | 'refresh-state'
    | 'list-groups'
    | 'list-clients'
    | 'create-group'
    | 'read-group'
    | 'join-group'
    | 'leave-group'
    | 'client-session-connect'
    | 'client-session-heartbeat'
    | 'client-session-disconnect'
    | 'group-presence-connect'
    | 'group-presence-heartbeat'
    | 'group-presence-disconnect'
    | 'group-events'
    | 'group-events-page'
    | 'client-events'
    | 'client-events-page';

export interface RoomsClientsAction {
    readonly actionId: RoomsClientsActionId;
    readonly label: string;
    /** Absent for an action that composes other actions instead of sending one preset. */
    readonly presetId?: string;
    /** Absent for a preset sent without query parameters. */
    readonly query?: Readonly<Record<string, number | string>>;
}

export interface RoomsClientsActionCategory {
    readonly categoryId: 'groups' | 'clients';
    readonly title: string;
    readonly description: string;
    readonly actions: readonly RoomsClientsAction[];
}

/** A group snapshot row; each time and version is absent when the snapshot does not carry it. */
export interface RoomStateRow {
    readonly rowId: string;
    readonly groupId: string;
    readonly displayName: string;
    readonly status: string;
    readonly members: number;
    readonly online: number;
    readonly sessions: readonly string[];
    readonly createdAtEpochMs?: number;
    readonly updatedAtEpochMs?: number;
    readonly activeAtEpochMs?: number;
    readonly mutatedAtEpochMs?: number;
    readonly snapshotVersion?: number;
}

/** A client snapshot row; each time and version is absent when the snapshot does not carry it. */
export interface ClientStateRow {
    readonly rowId: string;
    readonly principalId: string;
    readonly username: string;
    readonly status: string;
    readonly online: string;
    readonly sessions: readonly string[];
    readonly createdAtEpochMs?: number;
    readonly updatedAtEpochMs?: number;
    readonly activeAtEpochMs?: number;
    readonly mutatedAtEpochMs?: number;
    readonly snapshotVersion?: number;
}

export type GroupSortId =
    | 'active-desc'
    | 'mutated-desc'
    | 'created-desc'
    | 'online-desc'
    | 'members-desc'
    | 'name-asc'
    | 'status-asc';

export type ClientSortId =
    | 'online-active-desc'
    | 'active-desc'
    | 'mutated-desc'
    | 'created-desc'
    | 'sessions-desc'
    | 'name-asc'
    | 'status-asc';

export interface StateEventRow {
    readonly rowId: string;
    readonly eventType: string;
    readonly subject: string;
    readonly snapshotVersion: string;
    /** Absent for an event without an occurrence time. */
    readonly atEpochMs?: number;
}

export type RoomsClientsDirectAction = 'refresh' | 'create' | 'join' | 'leave';

export interface RoomsClientsDraftModel {
    readonly apiBaseUrl: string;
    setApiBaseUrl(value: string): void;
    readonly variables: RallarServerWorkbenchVariables;
    updateVariable<K extends keyof RallarServerWorkbenchVariables>(
        key: K,
        value: RallarServerWorkbenchVariables[K]
    ): void;
    readonly timeoutMs: number;
    setTimeoutMs(value: number): void;
    readonly onlyGroupsWithMembers: boolean;
    setOnlyGroupsWithMembers(value: boolean): void;
    readonly onlyOnlineClients: boolean;
    setOnlyOnlineClients(value: boolean): void;
    readonly groupSort: GroupSortId;
    setGroupSort(value: GroupSortId): void;
    readonly clientSort: ClientSortId;
    setClientSort(value: ClientSortId): void;
    readonly expectedOtherClient: string;
    setExpectedOtherClient(value: string): void;
}

export interface RoomsClientsActivity {
    readonly busyAction: string | undefined;
    readonly localError: string | undefined;
    readonly actionFeedback: CommandCenterActionFeedback;
    readonly actions: readonly CommandCenterRestActionLog[];
}

export interface RoomsClientsRows {
    readonly groupRows: readonly RoomStateRow[];
    readonly clientRows: readonly ClientStateRow[];
    readonly visibleGroupRows: readonly RoomStateRow[];
    readonly visibleClientRows: readonly ClientStateRow[];
    readonly sortedGroupRows: readonly RoomStateRow[];
    readonly sortedClientRows: readonly ClientStateRow[];
    readonly stateEvents: readonly StateEventRow[];
    readonly expectedClients: readonly string[];
    readonly observedClients: readonly string[];
    readonly missingClients: readonly string[];
    readonly currentSessionInGroup: boolean;
    readonly currentClientOnline: boolean;
    readonly expectedOtherClientVisible: boolean;
}

export interface RoomsClientsOperations {
    runPresetAction(action: RoomsClientsAction): Promise<void>;
    refreshState(): Promise<void>;
    runDirectRoomsAction(action: RoomsClientsDirectAction): Promise<void>;
    copyStateRecipe(): Promise<void>;
}

export interface RoomsClientsSortOption<T extends GroupSortId | ClientSortId> {
    readonly value: T;
    readonly label: string;
}

export const GROUP_SORT_OPTIONS: readonly RoomsClientsSortOption<GroupSortId>[] = [
    { value: 'active-desc', label: 'Recently active' },
    { value: 'mutated-desc', label: 'Mutated newest' },
    { value: 'created-desc', label: 'Created newest' },
    { value: 'online-desc', label: 'Online members' },
    { value: 'members-desc', label: 'Members' },
    { value: 'name-asc', label: 'Name / ID' },
    { value: 'status-asc', label: 'Status' }
];

export const CLIENT_SORT_OPTIONS: readonly RoomsClientsSortOption<ClientSortId>[] = [
    { value: 'online-active-desc', label: 'Online first' },
    { value: 'active-desc', label: 'Recently active' },
    { value: 'mutated-desc', label: 'Mutated newest' },
    { value: 'created-desc', label: 'Created newest' },
    { value: 'sessions-desc', label: 'Sessions' },
    { value: 'name-asc', label: 'Name / ID' },
    { value: 'status-asc', label: 'Status' }
];

export const ROOMS_CLIENTS_ACTION_GROUPS: readonly RoomsClientsActionCategory[] = [
    {
        categoryId: 'groups',
        title: 'Groups',
        description: 'Group records, membership, group presence, and group event evidence.',
        actions: [
            {
                actionId: 'list-groups',
                label: 'List groups',
                presetId: 'groups-list'
            },
            {
                actionId: 'create-group',
                label: 'Create group',
                presetId: 'group-create'
            },
            {
                actionId: 'read-group',
                label: 'Read group',
                presetId: 'group-read'
            },
            {
                actionId: 'join-group',
                label: 'Join group',
                presetId: 'group-member-join'
            },
            {
                actionId: 'leave-group',
                label: 'Leave group',
                presetId: 'group-member-leave'
            },
            {
                actionId: 'group-presence-connect',
                label: 'Connect group presence',
                presetId: 'group-presence-connect'
            },
            {
                actionId: 'group-presence-heartbeat',
                label: 'Heartbeat group',
                presetId: 'group-presence-heartbeat'
            },
            {
                actionId: 'group-presence-disconnect',
                label: 'Disconnect group',
                presetId: 'group-presence-disconnect'
            },
            {
                actionId: 'group-events',
                label: 'List group events',
                presetId: 'group-events'
            },
            {
                actionId: 'group-events-page',
                label: 'List group events page',
                presetId: 'group-events-page',
                query: { limit: 20 }
            }
        ]
    },
    {
        categoryId: 'clients',
        title: 'Clients',
        description: 'Client snapshots, client session presence, and client event evidence.',
        actions: [
            {
                actionId: 'list-clients',
                label: 'List clients',
                presetId: 'clients-list'
            },
            {
                actionId: 'client-session-connect',
                label: 'Connect client presence',
                presetId: 'client-session-connect'
            },
            {
                actionId: 'client-session-heartbeat',
                label: 'Heartbeat client',
                presetId: 'client-session-heartbeat'
            },
            {
                actionId: 'client-session-disconnect',
                label: 'Disconnect client',
                presetId: 'client-session-disconnect'
            },
            {
                actionId: 'client-events',
                label: 'List client events',
                presetId: 'client-events'
            },
            {
                actionId: 'client-events-page',
                label: 'List client events page',
                presetId: 'client-events-page',
                query: { limit: 20 }
            }
        ]
    }
];
export const ROOMS_CLIENTS_ACTIONS: readonly RoomsClientsAction[] = ROOMS_CLIENTS_ACTION_GROUPS.flatMap((group) =>
    group.actions
);
