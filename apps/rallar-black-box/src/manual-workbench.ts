import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestTransport
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import type { RallarBlackBoxProviderMode } from './client-defaults.ts';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from './client-defaults.ts';

export type ManualWorkbenchTransport = Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc' | 'ws'>;

export type ManualDeliveryMode = 'direct' | 'multicast' | 'broadcast';

export type ManualWorkbenchAction =
    | 'configure'
    | 'join'
    | 'connect'
    | 'send'
    | 'health'
    | 'close'
    | 'reset';

export interface ManualWorkbenchValues {
    readonly environment: string;
    readonly apiBaseUrl: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly actor: string;
    readonly sessionId: string;
    readonly groupId: string;
    readonly scopeText: string;
    readonly roomRefText: string;
    readonly minSnapshotVersion: number;
    readonly connection: string;
    readonly targetClient: string;
    readonly multicastClients: string;
    readonly transport: ManualWorkbenchTransport;
    readonly deliveryMode: ManualDeliveryMode;
    readonly wsUrl: string;
    readonly topic: string;
    readonly typeId: string;
    readonly topicId: string;
    readonly timeoutMs: number;
    readonly providerMode: RallarBlackBoxProviderMode;
    readonly rallarUsername?: string;
    readonly rallarPassword?: string;
    readonly rallarRegister: boolean;
    readonly rallarRestoreSession: boolean;
    readonly rallarLogoutOnClose: boolean;
    readonly rallarLeaveRoomOnClose: boolean;
}

export interface ManualPayloadPreset {
    readonly presetId: string;
    readonly label: string;
    readonly payload: RallarMessagePayload;
}

export interface ManualActionHistoryEntry {
    readonly actionId: string;
    readonly label: string;
    readonly commandIds: readonly string[];
    readonly commands: readonly RallarBlackBoxTestCommand[];
    readonly atEpochMs: number;
}

export interface ManualReceivedMessage {
    readonly eventId: string;
    readonly connection: string;
    readonly transport: string;
    readonly sender: string;
    readonly topic: string;
    readonly atEpochMs: number;
    readonly payload: unknown;
    readonly commandId?: string;
}

export type JsonParseResult =
    | Readonly<{ ok: true; value: RallarMessagePayload; }>
    | Readonly<{ ok: false; error: string; }>;

export const MANUAL_PAYLOAD_PRESETS: readonly ManualPayloadPreset[] = [
    {
        presetId: 'ping',
        label: 'Ping',
        payload: {
            topic: 'manual.ping',
            kind: 'ping',
            seq: 1
        }
    },
    {
        presetId: 'parity-probe',
        label: 'Parity Probe',
        payload: {
            topic: 'manual.parity',
            probeId: 'manual-parity-1',
            sentAt: 'manual-clock'
        }
    },
    {
        presetId: 'membership-probe',
        label: 'Membership Probe',
        payload: {
            topic: 'manual.membership',
            expectedClients: []
        }
    }
];

export const DEFAULT_MANUAL_WORKBENCH_VALUES: ManualWorkbenchValues = {
    environment: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.environment,
    apiBaseUrl: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.apiBaseUrl,
    applicationId: DEFAULT_STATE_APPLICATION_ID,
    workspaceId: DEFAULT_STATE_WORKSPACE_ID,
    actor: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.actor,
    sessionId: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.sessionId,
    groupId: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.roomId,
    scopeText: '',
    roomRefText: '',
    minSnapshotVersion: 0,
    connection: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.connection,
    targetClient: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.targetClient,
    multicastClients: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.multicastClients,
    transport: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.transport,
    deliveryMode: 'direct',
    wsUrl: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.wsUrl,
    topic: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.topic,
    typeId: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.typeId,
    topicId: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.topicId,
    timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
    providerMode: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.providerMode,
    rallarUsername: undefined,
    rallarPassword: undefined,
    rallarRegister: false,
    rallarRestoreSession: false,
    rallarLogoutOnClose: false,
    rallarLeaveRoomOnClose: true
};

export function parseManualPayload(text: string): JsonParseResult {
    try {
        return {
            ok: true,
            value: JSON.parse(text)
        };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export function toManualRecipeText(
    entries: readonly ManualActionHistoryEntry[]
): string {
    const commands = entries.flatMap((entry) => entry.commands);
    return JSON.stringify(
        {
            schemaVersion: 1,
            recipeId: 'manual-workbench-recipe',
            name: 'Manual workbench recipe',
            continueOnFailure: false,
            commands
        },
        null,
        2
    );
}

export function deriveManualReceivedMessages(
    events: readonly RallarBlackBoxTestEvent[]
): readonly ManualReceivedMessage[] {
    return events
        .filter((event) => event.kind === 'message')
        .map((event) => {
            const payload = toRecord(event.payload);
            const data = toRecord(payload.data);
            const nestedData = toRecord(data.data);
            const envelope = toRecord(data.payload);
            return {
                eventId: event.eventId,
                connection: event.connection ?? 'default',
                transport: event.transport ?? 'runtime',
                sender: toFirstText([
                    payload.senderId,
                    payload.remotePeerId,
                    data.senderId,
                    data.sender,
                    nestedData.senderId,
                    nestedData.sender,
                    event.actor
                ]) ?? '-',
                topic: toFirstText([
                    payload.topicId,
                    payload.topic,
                    data.topic,
                    nestedData.topic,
                    envelope.topic,
                    event.topic
                ]) ?? event.topic,
                atEpochMs: typeof payload.receivedAtEpochMs === 'number'
                    ? payload.receivedAtEpochMs
                    : event.atEpochMs,
                payload: payload.data ?? event.payload,
                commandId: event.commandId
            };
        });
}

function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function toFirstText(values: readonly unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }

    return undefined;
}
