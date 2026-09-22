import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestConfig, RallarBlackBoxTestTransport } from './rallar-black-box-test-contracts.ts';
import { decodeRecord } from './runtime/decode-runtime-result-values.ts';

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

const PROVIDER_MODE_NAMES = RALLAR_BLACK_BOX_PROVIDER_MODES.join(', ');

/**
 * Every configuration producer writes control.providerMode, so it is the only key read. A configuration without
 * one runs the default mode; a value that names no mode is refused, never replaced by the default.
 */
export function decodeRallarBlackBoxConfigProviderMode(
    config: RallarBlackBoxTestConfig | undefined
): Either<string, RallarBlackBoxProviderMode> {
    const providerMode = decodeRecord(config?.control).providerMode;
    if (providerMode === undefined) {
        return Either.ofRight(RALLAR_BLACK_BOX_CLIENT_DEFAULTS.providerMode);
    }
    return typeof providerMode === 'string' && isRallarBlackBoxProviderMode(providerMode)
        ? Either.ofRight(providerMode)
        : Either.ofLeft(`control.providerMode must be one of ${PROVIDER_MODE_NAMES}, not '${String(providerMode)}'.`);
}

export function isRallarBlackBoxProviderMode(value: string): value is RallarBlackBoxProviderMode {
    return RALLAR_BLACK_BOX_PROVIDER_MODES.some((providerMode) => providerMode === value);
}
