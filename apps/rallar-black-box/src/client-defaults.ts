import type { RallarBlackBoxTestTransport } from '@shared-test/rallar-bb-test/types.ts';

export type RallarBlackBoxProviderMode = 'simulated' | 'browser-rallar';

export const RALLAR_BLACK_BOX_CLIENT_DEFAULTS = {
    mode: 'local-workbench',
    autoConnect: false,
    providerMode: 'simulated' satisfies RallarBlackBoxProviderMode,
    controlUrl: 'ws://localhost:5180/control',
    localRunId: 'local-workbench-run',
    controlRunId: 'control-run-local',
    agentId: 'visible-agent-local',
    environment: 'local',
    apiBaseUrl: 'https://api.example.invalid',
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
    statsIntervalMs: 5_000,
    demoUsername: 'alice',
    demoPassword: 'local-demo-password',
    demoToken: 'local-demo-token',
} as const;

export type RallarBlackBoxClientDefaults = typeof RALLAR_BLACK_BOX_CLIENT_DEFAULTS;

export function parseRallarBlackBoxProviderMode(
    value: string | undefined,
): RallarBlackBoxProviderMode {
    return value === 'browser-rallar'
        ? 'browser-rallar'
        : RALLAR_BLACK_BOX_CLIENT_DEFAULTS.providerMode;
}
