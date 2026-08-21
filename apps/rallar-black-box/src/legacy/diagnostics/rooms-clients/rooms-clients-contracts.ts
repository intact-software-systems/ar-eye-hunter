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

export type RoomsClientsAction = Readonly<{
    actionId: RoomsClientsActionId;
    label: string;
    presetId?: string;
    query?: Readonly<Record<string, unknown>>;
}>;

export type RoomsClientsActionCategory = Readonly<{
    categoryId: 'groups' | 'clients';
    title: string;
    description: string;
    actions: readonly RoomsClientsAction[];
}>;

export type RoomStateRow = Readonly<{
    rowId: string;
    groupId: string;
    displayName: string;
    status: string;
    members: number;
    online: number;
    sessions: readonly string[];
    createdAtEpochMs?: number;
    updatedAtEpochMs?: number;
    activeAtEpochMs?: number;
    mutatedAtEpochMs?: number;
    snapshotVersion?: number;
}>;

export type ClientStateRow = Readonly<{
    rowId: string;
    principalId: string;
    username: string;
    status: string;
    online: string;
    sessions: readonly string[];
    createdAtEpochMs?: number;
    updatedAtEpochMs?: number;
    activeAtEpochMs?: number;
    mutatedAtEpochMs?: number;
    snapshotVersion?: number;
}>;

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

export type StateEventRow = Readonly<{
    rowId: string;
    eventType: string;
    subject: string;
    snapshotVersion: string;
    atEpochMs?: number;
}>;

export const GROUP_SORT_OPTIONS: readonly Readonly<{
    value: GroupSortId;
    label: string;
}>[] = [
    { value: 'active-desc', label: 'Recently active' },
    { value: 'mutated-desc', label: 'Mutated newest' },
    { value: 'created-desc', label: 'Created newest' },
    { value: 'online-desc', label: 'Online members' },
    { value: 'members-desc', label: 'Members' },
    { value: 'name-asc', label: 'Name / ID' },
    { value: 'status-asc', label: 'Status' }
];

export const CLIENT_SORT_OPTIONS: readonly Readonly<{
    value: ClientSortId;
    label: string;
}>[] = [
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
