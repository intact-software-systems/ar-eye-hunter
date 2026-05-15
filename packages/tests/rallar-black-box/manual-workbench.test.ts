import { describe, expect, it } from 'vitest';
import type { RallarBlackBoxTestEvent } from '../../shared-test/rallar-bb-test/types.ts';
import {
    DEFAULT_MANUAL_WORKBENCH_VALUES,
    buildManualWorkbenchCommands,
    deriveManualReceivedMessages,
    manualRecipeSnippet,
    parseManualPayload,
    type ManualActionHistoryEntry,
} from '../../../apps/rallar-black-box/src/manual-workbench.ts';

describe('rallar-black-box manual workbench helpers', () => {
    it('builds direct realtime sends with explicit peer targets', () => {
        const [command] = buildManualWorkbenchCommands(
            'send',
            {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'realtime',
                deliveryMode: 'direct',
                targetClient: 'bob-peer',
            },
            { text: 'hello' },
            7,
        );

        expect(command).toMatchObject({
            kind: 'rtc.send',
            commandId: 'manual-rtc-send-direct-7',
            connection: 'aliceRtc',
            transport: 'realtime',
            send: {
                data: {
                    text: 'hello',
                },
                roomId: 'rallar-black-box-room',
                peerIds: ['bob-peer'],
            },
            metadata: {
                manual: {
                    deliveryMode: 'direct',
                    targets: ['bob-peer'],
                },
            },
        });
    });

    it('builds messages.rtc multicast sends with next hop targets', () => {
        const [command] = buildManualWorkbenchCommands(
            'send',
            {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'messages.rtc',
                deliveryMode: 'multicast',
                multicastClients: 'bob-peer, charlie-peer',
                typeId: 'chat',
                topicId: 'room-message',
            },
            { text: 'hello' },
            8,
        );

        expect(command).toMatchObject({
            kind: 'rtc.send',
            commandId: 'manual-rtc-send-multicast-8',
            transport: 'messages.rtc',
            send: {
                payload: {
                    text: 'hello',
                },
                typeId: 'chat',
                topicId: 'room-message',
                nextHopPeerIds: ['bob-peer', 'charlie-peer'],
            },
        });
    });

    it('wraps WebSocket broadcast sends with group delivery metadata', () => {
        const [command] = buildManualWorkbenchCommands(
            'send',
            {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'ws',
                deliveryMode: 'broadcast',
            },
            { text: 'hello' },
            9,
        );

        expect(command).toMatchObject({
            kind: 'ws.send',
            commandId: 'manual-ws-send-broadcast-9',
            data: {
                groupId: 'rallar-black-box-room',
                topic: 'manual.message',
                deliveryMode: 'broadcast',
                targets: [],
                payload: {
                    text: 'hello',
                },
            },
        });
    });

    it('builds join as configure plus transport connection command', () => {
        const commands = buildManualWorkbenchCommands(
            'join',
            {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'ws',
                wsUrl: 'wss://control.example.test/group',
            },
            {},
            10,
        );

        expect(commands.map(command => command.kind)).toEqual(['configure', 'ws.open']);
        expect(commands[0].commandId).toBe('manual-configure-10');
        expect(commands[1]).toMatchObject({
            commandId: 'manual-ws-open-11',
            url: 'wss://control.example.test/group',
        });
    });

    it('validates payload JSON before command execution', () => {
        expect(parseManualPayload('{"ok":true}')).toEqual({
            ok: true,
            value: {
                ok: true,
            },
        });

        expect(parseManualPayload('{')).toMatchObject({
            ok: false,
        });
    });

    it('derives received inbox rows from runtime message events', () => {
        const messages = deriveManualReceivedMessages([
            {
                eventId: 'event-1',
                kind: 'message',
                topic: 'rallar.browser.messages.rtc.message',
                atEpochMs: 123,
                commandId: 'send-1',
                connection: 'aliceRtc',
                transport: 'messages.rtc',
                payload: {
                    senderId: 'bob-peer',
                    topicId: 'room-message',
                    data: {
                        text: 'hello',
                    },
                },
            } satisfies RallarBlackBoxTestEvent,
        ]);

        expect(messages).toEqual([
            {
                eventId: 'event-1',
                commandId: 'send-1',
                connection: 'aliceRtc',
                transport: 'messages.rtc',
                sender: 'bob-peer',
                topic: 'room-message',
                atEpochMs: 123,
                payload: {
                    text: 'hello',
                },
            },
        ]);
    });

    it('turns manual action history into a repeatable recipe snippet', () => {
        const entry: ManualActionHistoryEntry = {
            actionId: 'action-1',
            label: 'Health',
            atEpochMs: 123,
            commandIds: ['manual-health-1'],
            commands: [
                {
                    kind: 'health',
                    commandId: 'manual-health-1',
                },
            ],
        };

        expect(JSON.parse(manualRecipeSnippet([entry]))).toMatchObject({
            recipeId: 'manual-workbench-recipe',
            commands: [
                {
                    kind: 'health',
                    commandId: 'manual-health-1',
                },
            ],
        });
    });
});
