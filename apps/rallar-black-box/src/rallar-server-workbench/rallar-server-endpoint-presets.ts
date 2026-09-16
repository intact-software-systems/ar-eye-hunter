import { RALLAR_SERVER_STATE_ENDPOINT_PRESETS } from './rallar-server-state-endpoint-presets.ts';
import type { RallarServerEndpointPreset } from './rallar-server-workbench-contracts.ts';

export const RALLAR_SERVER_ENDPOINT_PRESETS: readonly RallarServerEndpointPreset[] = [
    {
        presetId: 'config-read',
        tag: 'Config',
        label: 'Read runtime config',
        method: 'GET',
        pathTemplate: '/api/config',
        requiresAuth: false
    },
    {
        presetId: 'auth-ws-ticket',
        tag: 'Auth',
        label: 'Create WS ticket',
        method: 'POST',
        pathTemplate: '/api/auth/ws-ticket/requests/{requestId}',
        requiresAuth: true,
        body: {}
    },
    {
        presetId: 'webrtc-ice',
        tag: 'WebRTC',
        label: 'Read ICE servers',
        method: 'GET',
        pathTemplate: '/api/webrtc/ice',
        requiresAuth: true
    },
    ...RALLAR_SERVER_STATE_ENDPOINT_PRESETS,
    {
        presetId: 'openapi-json',
        tag: 'Docs',
        label: 'Read OpenAPI JSON',
        method: 'GET',
        pathTemplate: '/api/openapi.json',
        requiresAuth: false
    }
];
