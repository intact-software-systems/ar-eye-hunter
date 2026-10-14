import { json } from '../../shared/json-presentation.ts';
import type { WebSocketPayloadPreset } from './websocket-contracts.ts';

export const WEBSOCKET_PAYLOAD_PRESETS: readonly WebSocketPayloadPreset[] = [
    {
        presetId: 'ping',
        label: 'Ping - world scope',
        description: 'Broadcast liveness payload to the signed-in world scope. It is not tied to the Group field.',
        payload: {
            seq: 1,
            text: 'ping from rallar-black-box'
        },
        values: {
            wsScope: 'world',
            typeId: 'app.black-box.ws.ping',
            topicId: 'app.black-box.ws.ping',
            contextId: 'world'
        }
    },
    {
        presetId: 'group-message',
        label: 'Group Message - current group',
        description: 'Broadcast payload to the configured Group using room scope.',
        payload: {
            deliveryMode: 'broadcast',
            text: 'hello from rallar-black-box'
        },
        values: {
            wsScope: 'room',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message'
        }
    },
    {
        presetId: 'parity-probe',
        label: 'Compare WS vs RTC - current group',
        description: 'Use this payload when comparing WebSocket and RTC delivery for the same group.',
        payload: {
            transport: 'ws',
            seq: 1
        },
        values: {
            wsScope: 'room',
            typeId: 'room.black-box.transport-check',
            topicId: 'room.black-box.transport-check'
        }
    }
];
export const DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID = 'group-message';

export function webSocketPayloadPresetText(presetId: string): string | undefined {
    const preset = WEBSOCKET_PAYLOAD_PRESETS.find(
        (entry) => entry.presetId === presetId
    );
    return preset ? json(preset.payload) : undefined;
}

export function webSocketPayloadPresetById(presetId: string): WebSocketPayloadPreset {
    return (
        WEBSOCKET_PAYLOAD_PRESETS.find(
            (entry) => entry.presetId === presetId
        ) ?? WEBSOCKET_PAYLOAD_PRESETS[0]
    );
}
