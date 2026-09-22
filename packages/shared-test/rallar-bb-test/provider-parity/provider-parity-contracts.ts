import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestTransport
} from '../rallar-black-box-test-contracts.ts';

export type RallarBlackBoxParityOperation =
    | 'configure'
    | 'connect'
    | 'send.direct'
    | 'send.multicast'
    | 'send.broadcast'
    | 'receive.direct'
    | 'receive.multicast'
    | 'receive.broadcast'
    | 'health'
    | 'close'
    | 'reset';

export type RallarBlackBoxRunnerProviderName =
    | 'rallar-browser'
    | 'rallar-remote-browser';

export type RallarBlackBoxParityDeliveryMode =
    | 'direct'
    | 'multicast'
    | 'broadcast';

export interface RallarBlackBoxParityCommandMetadata {
    readonly operation: RallarBlackBoxParityOperation;
    readonly deliveryMode?: RallarBlackBoxParityDeliveryMode;
    readonly expectedConnections?: readonly string[];
    readonly targetPeerIds?: readonly string[];
    readonly runnerAction?: 'connect' | 'send' | 'wait' | 'close';
    readonly providerSpecificFields?: readonly string[];
}

export interface RallarBlackBoxProviderParityRecipeOptions {
    readonly recipeId?: string;
    readonly name?: string;
    readonly description?: string;
    readonly runId?: string;
    readonly agentId?: string;
    readonly environment?: string;
    readonly apiBaseUrl?: string;
    readonly actor?: string;
    readonly sessionId?: string;
    readonly roomId?: string;
    readonly connection?: string;
    readonly transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    readonly timeoutMs?: number;
    readonly providerMode?: 'simulated' | 'browser-rallar';
    readonly includeDemoAuth?: boolean;
    readonly rallar?: RallarBlackBoxTestRecord;
    readonly browser?: RallarBlackBoxTestRecord;
    readonly control?: RallarBlackBoxTestRecord;
    readonly directPeerIds?: readonly string[];
    readonly directExpectedConnections?: readonly string[];
    readonly multicastPeerIds?: readonly string[];
    readonly multicastExpectedConnections?: readonly string[];
    readonly broadcastExpectedConnections?: readonly string[];
}

export interface RallarBlackBoxRunnerParityOptions {
    readonly provider?: RallarBlackBoxRunnerProviderName;
    readonly scenarioExecutionNumber?: number;
    readonly includeReceiveWaits?: boolean;
    readonly messageShape?: 'raw' | 'event';
}

export interface RallarBlackBoxRunnerParityOmittedCommand {
    readonly commandId: string;
    readonly kind: RallarBlackBoxTestCommand['kind'];
    readonly operation: RallarBlackBoxParityOperation | string;
    readonly reason: string;
}

export interface RallarBlackBoxRunnerParityConversion {
    readonly interactions: readonly RallarBlackBoxTestRecord[];
    readonly omittedCommands: readonly RallarBlackBoxRunnerParityOmittedCommand[];
}

export interface RallarBlackBoxProviderParityStep {
    readonly key: string;
    readonly operation: RallarBlackBoxParityOperation | string;
    readonly status: 'ok' | 'failed' | 'cancelled' | 'skipped';
    readonly commandId?: string;
    readonly kind?: string;
    readonly action?: string;
    readonly connection?: string;
    readonly transport?: string;
    readonly comparable: RallarBlackBoxTestRecord;
    readonly providerSpecific: RallarBlackBoxTestRecord;
}

export interface RallarBlackBoxProviderParityReport {
    readonly source: 'rallar-bb-test' | 'black-box-runner';
    readonly steps: readonly RallarBlackBoxProviderParityStep[];
    readonly providerSpecificFields: readonly string[];
}

export interface RallarBlackBoxProviderParityComparison {
    readonly ok: boolean;
    readonly matchedKeys: readonly string[];
    readonly missingLeft: readonly string[];
    readonly missingRight: readonly string[];
    readonly statusMismatches: readonly Readonly<{
        key: string;
        left: string;
        right: string;
    }>[];
}
