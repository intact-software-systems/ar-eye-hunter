import type { RallarServerEndpointPreset } from './rallar-server-workbench-contracts.ts';

function stateWorkbenchPath(suffix: string): string {
  return '/api/state/apps/{applicationId}/workspaces/{workspaceId}' + suffix;
}

export const RALLAR_SERVER_STATE_ENDPOINT_PRESETS: readonly RallarServerEndpointPreset[] = [
  {
    presetId: 'clients-list',
    tag: 'Client State',
    label: 'List clients',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/clients'),
    requiresAuth: true,
  },
  {
    presetId: 'client-read',
    tag: 'Client State',
    label: 'Read current client',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/clients/{principalId}'),
    requiresAuth: true,
  },
  {
    presetId: 'client-presence',
    tag: 'Client State',
    label: 'Read current client presence',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/clients/{principalId}/presence'),
    requiresAuth: true,
  },
  {
    presetId: 'client-events',
    tag: 'Client State',
    label: 'List current client events',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/clients/{principalId}/events'),
    requiresAuth: true,
  },
  {
    presetId: 'client-events-page',
    tag: 'Client State',
    label: 'List current client events page',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/clients/{principalId}/events/page'),
    requiresAuth: true,
  },
  {
    presetId: 'client-principal-upsert',
    tag: 'Client State',
    label: 'Upsert current client principal',
    method: 'PUT',
    pathTemplate: stateWorkbenchPath('/clients/{principalId}/principal/requests/{requestId}'),
    requiresAuth: true,
    body: {
      username: '{username}',
      displayName: '{username}',
      status: 'active',
    },
  },
  {
    presetId: 'client-instance-upsert',
    tag: 'Client State',
    label: 'Upsert current client instance',
    method: 'PUT',
    pathTemplate: stateWorkbenchPath(
      '/clients/{principalId}/instances/{clientInstanceId}/requests/{requestId}',
    ),
    requiresAuth: true,
    body: {
      status: 'active',
      platform: 'browser',
      deviceLabel: 'rallar-black-box',
      capabilities: ['black-box-testing'],
    },
  },
  {
    presetId: 'client-session-connect',
    tag: 'Client State',
    label: 'Connect current client session',
    method: 'PUT',
    pathTemplate: stateWorkbenchPath(
      '/clients/{principalId}/instances/{clientInstanceId}' +
        '/sessions/{sessionId}/requests/{requestId}',
    ),
    requiresAuth: true,
    body: {
      generationId: '{generationId}',
      presenceState: 'online',
      transport: 'rtc',
      connectionId: 'rallar-black-box',
    },
  },
  {
    presetId: 'client-session-heartbeat',
    tag: 'Client State',
    label: 'Heartbeat current client session',
    method: 'POST',
    pathTemplate: stateWorkbenchPath(
      '/clients/{principalId}/instances/{clientInstanceId}' +
        '/sessions/{sessionId}/heartbeat/requests/{requestId}',
    ),
    requiresAuth: true,
    body: {
      generationId: '{generationId}',
      presenceState: 'online',
    },
  },
  {
    presetId: 'client-session-disconnect',
    tag: 'Client State',
    label: 'Disconnect current client session',
    method: 'POST',
    pathTemplate: stateWorkbenchPath(
      '/clients/{principalId}/instances/{clientInstanceId}' +
        '/sessions/{sessionId}/disconnect/requests/{requestId}',
    ),
    requiresAuth: true,
    body: {
      generationId: '{generationId}',
    },
  },
  {
    presetId: 'groups-list',
    tag: 'Group State',
    label: 'List groups',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/groups'),
    requiresAuth: true,
  },
  {
    presetId: 'group-create',
    tag: 'Group State',
    label: 'Create group',
    method: 'POST',
    pathTemplate: stateWorkbenchPath('/groups/requests/{requestId}'),
    requiresAuth: true,
    body: {
      groupId: '{groupId}',
      displayName: '{groupId}',
      description: 'Created by rallar-black-box',
      kind: 'room',
      joinMode: 'open',
      createdByPrincipalId: '{principalId}',
      metadata: {
        source: 'rallar-black-box',
      },
    },
  },
  {
    presetId: 'group-read',
    tag: 'Group State',
    label: 'Read group',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}'),
    requiresAuth: true,
  },
  {
    presetId: 'group-member-join',
    tag: 'Group State',
    label: 'Join group',
    method: 'PUT',
    pathTemplate: stateWorkbenchPath(
      '/groups/{groupId}/members/{principalId}/requests/{requestId}',
    ),
    requiresAuth: true,
    body: {
      status: 'active',
    },
  },
  {
    presetId: 'group-member-leave',
    tag: 'Group State',
    label: 'Leave group',
    method: 'PUT',
    pathTemplate: stateWorkbenchPath(
      '/groups/{groupId}/members/{principalId}/requests/{requestId}',
    ),
    requiresAuth: true,
    body: {
      status: 'left',
    },
  },
  {
    presetId: 'group-presence-connect',
    tag: 'Group State',
    label: 'Connect group presence',
    method: 'PUT',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/sessions/{sessionId}/requests/{requestId}'),
    requiresAuth: true,
    body: {
      principalId: '{principalId}',
    },
  },
  {
    presetId: 'group-presence-heartbeat',
    tag: 'Group State',
    label: 'Heartbeat group presence',
    method: 'POST',
    pathTemplate: stateWorkbenchPath(
      '/groups/{groupId}/sessions/{sessionId}/heartbeat/requests/{requestId}',
    ),
    requiresAuth: true,
    body: {
      principalId: '{principalId}',
    },
  },
  {
    presetId: 'group-presence-disconnect',
    tag: 'Group State',
    label: 'Disconnect group presence',
    method: 'POST',
    pathTemplate: stateWorkbenchPath(
      '/groups/{groupId}/sessions/{sessionId}/disconnect/requests/{requestId}',
    ),
    requiresAuth: true,
    body: {
      principalId: '{principalId}',
    },
  },
  {
    presetId: 'group-events',
    tag: 'Group State',
    label: 'List group events',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/events'),
    requiresAuth: true,
  },
  {
    presetId: 'group-events-page',
    tag: 'Group State',
    label: 'List group events page',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/events/page'),
    requiresAuth: true,
  },
  {
    presetId: 'graph-scoped-global',
    tag: 'Graph',
    label: 'Read scoped global graph',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/graphs/global'),
    requiresAuth: false,
  },
  {
    presetId: 'group-graph-latest',
    tag: 'Graph',
    label: 'Read latest group graph',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/graphs/latest'),
    requiresAuth: true,
  },
  {
    presetId: 'group-topology-read',
    tag: 'Topology',
    label: 'Read group topology',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/topology'),
    requiresAuth: true,
  },
  {
    presetId: 'group-topology-config-read',
    tag: 'Topology',
    label: 'Read group topology config',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/topology/config'),
    requiresAuth: true,
  },
  {
    presetId: 'group-topology-config-put',
    tag: 'Topology',
    label: 'Put group topology config',
    method: 'PUT',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/topology/config/requests/{requestId}'),
    requiresAuth: true,
    body: {
      config: {
        topologyKind: 'auto',
      },
      reconfigure: true,
    },
  },
  {
    presetId: 'group-topology-config-delete',
    tag: 'Topology',
    label: 'Delete group topology config',
    method: 'DELETE',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/topology/config/requests/{requestId}'),
    requiresAuth: true,
  },
  {
    presetId: 'group-topology-override-read',
    tag: 'Topology',
    label: 'Read group topology override',
    method: 'GET',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/topology/override'),
    requiresAuth: true,
  },
  {
    presetId: 'group-topology-override-put',
    tag: 'Topology',
    label: 'Put group topology override',
    method: 'PUT',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/topology/override/requests/{requestId}'),
    requiresAuth: true,
    body: {
      config: {
        topologyKind: 'mesh',
      },
      ttlMs: 900000,
      reconfigure: true,
    },
  },
  {
    presetId: 'group-topology-override-delete',
    tag: 'Topology',
    label: 'Delete group topology override',
    method: 'DELETE',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/topology/override/requests/{requestId}'),
    requiresAuth: true,
  },
  {
    presetId: 'group-topology-reconfigure',
    tag: 'Topology',
    label: 'Reconfigure group topology',
    method: 'POST',
    pathTemplate: stateWorkbenchPath('/groups/{groupId}/topology/reconfigure/requests/{requestId}'),
    requiresAuth: true,
    body: {
      options: {
        topologyKind: 'auto',
      },
      publish: true,
    },
  },
];
