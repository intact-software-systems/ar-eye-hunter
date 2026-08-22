import type { RallarBlackBoxTestCommand, RallarBlackBoxTestTransport } from '../types.ts';

import type {
    RallarBlackBoxCompositeConformanceCaseId,
    RallarBlackBoxCompositeConformanceRecipeOptions
} from '../composite-conformance.ts';

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_CONNECTION = 'conformanceRtc';
export const DEFAULT_WS_CONNECTION = 'conformanceWs';
export const DEFAULT_ROOM_ID = 'rallar-conformance-room';

export function configureCommand(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): Extract<RallarBlackBoxTestCommand, { kind: 'configure'; }> {
    return {
        kind: 'configure',
        commandId: `${caseId}-configure`,
        config: {
            runId: options.runId ?? 'rallar-composite-conformance-run',
            agentId: options.agentId ?? 'local-conformance-agent',
            environment: options.environment ?? 'local',
            apiBaseUrl: options.apiBaseUrl ?? 'http://localhost:8080',
            actor: options.actor ?? 'alice',
            sessionId: options.sessionId ?? 'alice-session',
            roomId: options.roomId ?? DEFAULT_ROOM_ID,
            transport: options.transport ?? 'realtime',
            rallar: {
                apiBaseUrl: options.apiBaseUrl ?? 'http://localhost:8080',
                wsBaseUrl: wsBaseUrl(options.apiBaseUrl ?? 'http://localhost:8080'),
                applicationId: options.applicationId ?? 'rallar-server',
                workspaceId: options.workspaceId ?? 'default',
                roomId: options.roomId ?? DEFAULT_ROOM_ID
            },
            control: {
                providerMode: options.providerMode ?? 'simulated',
                conformance: true
            },
            defaults: {
                timeoutMs: timeoutMs(options),
                connection: options.connection ?? DEFAULT_CONNECTION
            },
            redaction: {
                keys: ['password', 'accessToken', 'token']
            }
        },
        metadata: commandMetadata(caseId, `${caseId}-configure`)
    };
}

export function rtcConnectCommand(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    commandId: string,
    connection: string,
    roomId: string,
    transport: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>,
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect'; }> {
    return {
        kind: 'rtc.connect',
        commandId,
        connection,
        actor: options.actor ?? 'alice',
        roomId,
        transport,
        timeoutMs: timeoutMs(options),
        ...scopeFields(options),
        rallar: {
            sessionId: options.sessionId ?? 'alice-session',
            transport
        },
        metadata: commandMetadata(caseId, commandId)
    };
}

export function statsCommand(
    commandId: string,
    caseId: RallarBlackBoxCompositeConformanceCaseId
): Extract<RallarBlackBoxTestCommand, { kind: 'stats'; }> {
    return {
        kind: 'stats',
        commandId,
        metadata: commandMetadata(caseId, commandId)
    };
}

export function closeCommand(
    commandId: string,
    caseId: RallarBlackBoxCompositeConformanceCaseId
): Extract<RallarBlackBoxTestCommand, { kind: 'close'; }> {
    return {
        kind: 'close',
        commandId,
        metadata: commandMetadata(caseId, commandId)
    };
}

export function recipeId(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): string {
    return [options.recipeIdPrefix ?? 'composite-conformance', caseId].join('-');
}

export function timeoutMs(options: RallarBlackBoxCompositeConformanceRecipeOptions): number {
    return Number.isFinite(options.timeoutMs) && options.timeoutMs !== undefined &&
            options.timeoutMs > 0
        ? Math.round(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
}

export function scopeFields(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): Record<string, unknown> {
    return {
        applicationId: options.applicationId ?? 'rallar-server',
        workspaceId: options.workspaceId ?? 'default',
        roomRef: {
            applicationId: options.applicationId ?? 'rallar-server',
            workspaceId: options.workspaceId ?? 'default',
            groupId: options.roomId ?? DEFAULT_ROOM_ID
        }
    };
}

function wsBaseUrl(apiBaseUrl: string): string {
    try {
        const url = new URL(apiBaseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.toString().replace(/\/+$/, '');
    }
    catch {
        return 'ws://localhost:8080';
    }
}

export function recipeMetadata(
    caseId: RallarBlackBoxCompositeConformanceCaseId
): Record<string, unknown> {
    return {
        conformance: {
            schemaVersion: 1,
            caseId
        }
    };
}

export function commandMetadata(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    commandId: string
): Record<string, unknown> {
    return {
        conformance: {
            schemaVersion: 1,
            caseId,
            commandId
        }
    };
}
