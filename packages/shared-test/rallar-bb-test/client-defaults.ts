import type { RallarBlackBoxTestTransport } from './rallar-black-box-test-contracts.ts';

export const RALLAR_BLACK_BOX_PROVIDER_MODES = ['simulated', 'browser-rallar'] as const;

export type RallarBlackBoxProviderMode = typeof RALLAR_BLACK_BOX_PROVIDER_MODES[number];

export const RALLAR_BLACK_BOX_CLIENT_DEFAULTS = {
    mode: 'local-workbench',
    providerMode: 'simulated' satisfies RallarBlackBoxProviderMode,
    controlUrl: 'ws://localhost:5180/control',
    localRunId: 'local-workbench-run',
    controlRunId: 'control-run-local',
    agentId: 'visible-agent-local',
    environment: 'local',
    apiBaseUrl: 'https://api.example.invalid',
    applicationId: 'rallar-black-box',
    workspaceId: 'default',
    actor: 'alice',
    sessionId: 'visible-session-alice',
    roomId: 'rallar-black-box-room',
    transport: 'realtime' satisfies Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>,
    connection: 'aliceRtc',
    remoteConnection: 'remoteAgent',
    wsUrl: 'wss://control.example.invalid/runs/manual',
    topic: 'room.manual.message',
    typeId: 'room.manual.type',
    topicId: 'room.manual.topic',
    targetClient: 'bob',
    multicastClients: 'bob,charlie',
    timeoutMs: 20_000,
    heartbeatIntervalMs: 10_000,
    statsIntervalMs: 5_000,
    runnerAgentCount: 1,
    rallarRegister: false,
    rallarAuthStorage: 'local',
    rallarRestoreSession: false,
    rallarLogoutOnClose: false,
    rallarLeaveRoomOnClose: true,
    demoUsername: 'alice',
    demoPassword: 'local-demo-password',
    demoToken: 'local-demo-token'
} as const;

export function resolveRallarBlackBoxProviderMode(
    value: string | undefined
): RallarBlackBoxProviderMode {
    return value !== undefined && isRallarBlackBoxProviderMode(value)
        ? value
        : RALLAR_BLACK_BOX_CLIENT_DEFAULTS.providerMode;
}

export function isRallarBlackBoxProviderMode(value: string): value is RallarBlackBoxProviderMode {
    return RALLAR_BLACK_BOX_PROVIDER_MODES.some((providerMode) => providerMode === value);
}
