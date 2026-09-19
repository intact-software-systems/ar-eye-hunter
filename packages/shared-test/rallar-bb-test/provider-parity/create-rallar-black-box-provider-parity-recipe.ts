import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestTransport
} from '../rallar-black-box-test-contracts.ts';
import type {
    RallarBlackBoxParityDeliveryMode,
    RallarBlackBoxProviderParityRecipeOptions
} from './provider-parity-contracts.ts';
import { DEFAULT_PARITY_CONNECTION, toParityMetadata } from './to-parity-command-metadata.ts';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_ROOM_ID = 'rallar-black-box-room';
const DEFAULT_DIRECT_PEER_IDS = ['bob-session'] as const;
const DEFAULT_MULTICAST_PEER_IDS = ['bob-session', 'charlie-session'] as const;

function toNonEmptyStrings(values: readonly string[] | undefined): readonly string[] {
    return values
        ?.map((value) => value.trim())
        .filter((value) => value.length > 0) ?? [];
}

function toTimeoutMs(value: number | undefined): number {
    return Number.isFinite(value) && value !== undefined && value > 0
        ? Math.round(value)
        : DEFAULT_TIMEOUT_MS;
}

interface ParityPayloadInput {
    readonly transport: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    readonly deliveryMode: RallarBlackBoxParityDeliveryMode;
    readonly roomId: string;
    readonly sequence: number;
    readonly peerIds: readonly string[];
}
function toParityPayload(input: ParityPayloadInput): RallarBlackBoxTestRecord {
    const { transport, deliveryMode, roomId, peerIds } = input;
    const envelope = {
        topic: 'rallar.parity.probe',
        deliveryMode,
        roomId,
        payload: { sequence: input.sequence, kind: deliveryMode }
    };
    if (transport === 'messages.rtc') {
        return {
            payload: envelope,
            roomId,
            typeId: 'room.black-box.parity',
            topicId: `room.black-box.parity.${deliveryMode}`,
            ...(deliveryMode !== 'broadcast' && peerIds.length > 0 ? { nextHopPeerIds: peerIds } : {})
        };
    }
    return { data: envelope, roomId, ...(deliveryMode !== 'broadcast' && peerIds.length > 0 ? { peerIds } : {}) };
}

interface ParityRecipeContext {
    readonly options: RallarBlackBoxProviderParityRecipeOptions;
    readonly transport: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    readonly connection: string;
    readonly roomId: string;
    readonly timeoutMs: number;
}
export function createRallarBlackBoxProviderParityRecipe(
    options: RallarBlackBoxProviderParityRecipeOptions = {}
): RallarBlackBoxTestRecipe {
    const context: ParityRecipeContext = {
        options,
        transport: options.transport ?? 'realtime',
        connection: options.connection ?? DEFAULT_PARITY_CONNECTION,
        roomId: options.roomId ?? DEFAULT_ROOM_ID,
        timeoutMs: toTimeoutMs(options.timeoutMs)
    };
    return {
        schemaVersion: 1,
        recipeId: options.recipeId ?? 'rallar-provider-parity-recipe',
        name: options.name ?? 'Rallar provider parity recipe',
        description: options.description ??
            'Portable connect/send/health/close/reset recipe for visible SPA and black-box runner parity checks.',
        continueOnFailure: false,
        metadata: {
            parity: {
                version: 1,
                providerMode: options.providerMode ?? 'simulated',
                transport: context.transport,
                connection: context.connection,
                roomId: context.roomId
            }
        },
        commands: [
            toParityConfigureCommand(context),
            toParityConnectCommand(context),
            ...toParitySendCommands(context),
            ...toParityCompletionCommands(context.connection)
        ]
    };
}
function toParityConfigureCommand(context: ParityRecipeContext): RallarBlackBoxTestCommand {
    const { options, roomId, transport, timeoutMs, connection } = context;
    const demoRallarAuth = options.includeDemoAuth === false
        ? {}
        : { username: 'alice', password: 'local-demo-password', token: 'local-demo-token' };
    return {
        kind: 'configure',
        commandId: 'parity-configure',
        label: 'Configure provider parity run',
        config: {
            runId: options.runId ?? 'rallar-provider-parity-run',
            agentId: options.agentId ?? 'visible-agent-local',
            environment: options.environment ?? 'local',
            apiBaseUrl: options.apiBaseUrl ?? 'https://api.example.invalid',
            actor: options.actor ?? 'alice',
            sessionId: options.sessionId ?? 'alice-session',
            roomId,
            transport,
            rallar: { ...demoRallarAuth, ...(options.rallar ?? {}) },
            ...(options.browser ? { browser: options.browser } : {}),
            control: { providerMode: options.providerMode ?? 'simulated', parity: true, ...(options.control ?? {}) },
            defaults: { timeoutMs, connection }
        },
        metadata: { parity: toParityMetadata('configure') }
    };
}
function toParityConnectCommand(context: ParityRecipeContext): RallarBlackBoxTestCommand {
    const { options, roomId, transport, timeoutMs, connection } = context;
    return {
        kind: 'rtc.connect',
        commandId: 'parity-connect',
        label: 'Connect provider parity RTC client',
        connection,
        actor: options.actor ?? 'alice',
        roomId,
        transport,
        timeoutMs,
        rallar: { sessionId: options.sessionId ?? 'alice-session' },
        metadata: {
            parity: toParityMetadata('connect', { expectedConnections: [connection], runnerAction: 'connect' })
        }
    };
}
interface ParitySendTarget {
    readonly mode: RallarBlackBoxParityDeliveryMode;
    readonly peers: readonly string[];
    readonly expected: readonly string[];
}
function toParitySendCommands(context: ParityRecipeContext): readonly RallarBlackBoxTestCommand[] {
    const { options, connection, transport, timeoutMs, roomId } = context;
    const targets: readonly ParitySendTarget[] = [
        {
            mode: 'direct',
            peers: toNonEmptyStrings(options.directPeerIds ?? DEFAULT_DIRECT_PEER_IDS),
            expected: toNonEmptyStrings(options.directExpectedConnections ?? [connection])
        },
        {
            mode: 'multicast',
            peers: toNonEmptyStrings(options.multicastPeerIds ?? DEFAULT_MULTICAST_PEER_IDS),
            expected: toNonEmptyStrings(options.multicastExpectedConnections)
        },
        { mode: 'broadcast', peers: [], expected: toNonEmptyStrings(options.broadcastExpectedConnections) }
    ];
    return targets.map(({ mode, peers, expected }, index) => ({
        kind: 'rtc.send',
        commandId: `parity-send-${mode}`,
        label: `Send provider parity ${mode} payload`,
        connection,
        transport,
        timeoutMs,
        send: toParityPayload({ transport, deliveryMode: mode, roomId, sequence: index + 1, peerIds: peers }),
        metadata: {
            parity: toParityMetadata(`send.${mode}`, {
                deliveryMode: mode,
                expectedConnections: expected,
                ...(mode === 'broadcast' ? {} : { targetPeerIds: peers }),
                runnerAction: 'send'
            })
        }
    }));
}
function toParityCompletionCommands(connection: string): readonly RallarBlackBoxTestCommand[] {
    return [
        {
            kind: 'health',
            commandId: 'parity-health',
            label: 'Collect provider parity health',
            metadata: { parity: toParityMetadata('health') }
        },
        {
            kind: 'close',
            commandId: 'parity-close',
            label: 'Close provider parity runtime',
            metadata: {
                parity: toParityMetadata('close', { expectedConnections: [connection], runnerAction: 'close' })
            }
        },
        {
            kind: 'reset',
            commandId: 'parity-reset',
            label: 'Reset provider parity runtime',
            metadata: { parity: toParityMetadata('reset') }
        }
    ];
}
