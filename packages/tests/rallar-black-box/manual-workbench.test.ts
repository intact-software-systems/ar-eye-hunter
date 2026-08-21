import { describe, expect, it } from 'vitest';
import {
    buildManualWorkbenchCommands,
    DEFAULT_MANUAL_WORKBENCH_VALUES,
    deriveManualReceivedMessages,
    manualRecipeSnippet,
    manualRtcDeliveryMatrixCommands,
    manualRtcNegativeRecipeSnippet,
    parseManualPayload,
    type ManualActionHistoryEntry
} from '../../../apps/rallar-black-box/src/manual-workbench.ts';
import type { RallarBlackBoxTestEvent } from '../../shared-test/rallar-bb-test/types.ts';

describe('rallar-black-box manual workbench helpers', () => {
    it('builds direct realtime sends with explicit peer targets', () => {
        const [command] = buildManualWorkbenchCommands(
            'send',
            {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'realtime',
                deliveryMode: 'direct',
                targetClient: 'bob-peer'
            },
            { text: 'hello' },
            7
        );

        expect(command).toMatchObject({
            kind: 'rtc.send',
            commandId: 'manual-rtc-send-direct-7',
            connection: 'aliceRtc',
            transport: 'realtime',
            send: {
                data: {
                    text: 'hello'
                },
                roomId: 'rallar-black-box-room',
                peerIds: ['bob-peer']
            },
            metadata: {
                manual: {
                    deliveryMode: 'direct',
                    targets: ['bob-peer']
                }
            }
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
                topicId: 'room-message'
            },
            { text: 'hello' },
            8
        );

        expect(command).toMatchObject({
            kind: 'rtc.send',
            commandId: 'manual-rtc-send-multicast-8',
            transport: 'messages.rtc',
            send: {
                payload: {
                    text: 'hello'
                },
                typeId: 'chat',
                topicId: 'room-message',
                nextHopPeerIds: ['bob-peer', 'charlie-peer']
            }
        });
    });

    it('carries scoped RTC fields into connect, send, and group setup commands', () => {
        const values = {
            ...DEFAULT_MANUAL_WORKBENCH_VALUES,
            providerMode: 'browser-rallar' as const,
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            scopeText: '{"tenant":"tenant-1"}',
            roomRefText: '{"type":"group","id":"group-1"}',
            minSnapshotVersion: 42,
            transport: 'messages.rtc' as const
        };
        const commands = buildManualWorkbenchCommands('join', values, {}, 20);
        const [send] = buildManualWorkbenchCommands('send', values, { text: 'hello' }, 30);

        expect(commands[0]).toMatchObject({
            kind: 'configure',
            config: {
                defaults: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    scope: { tenant: 'tenant-1' },
                    roomRef: { type: 'group', id: 'group-1' },
                    minSnapshotVersion: 42
                }
            }
        });
        expect(commands[1]).toMatchObject({
            kind: 'http.request',
            request: {
                path: expect.stringMatching(
                    /^\/api\/state\/apps\/app-1\/workspaces\/workspace-1\/groups\/requests\/[^/]+$/
                )
            }
        });
        expect(commands[1]).not.toMatchObject({
            request: {
                body: {
                    requestId: expect.anything()
                }
            }
        });
        expect(commands[2]).toMatchObject({
            kind: 'rtc.connect',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            scope: { tenant: 'tenant-1' },
            roomRef: { type: 'group', id: 'group-1' },
            minSnapshotVersion: 42
        });
        expect(send).toMatchObject({
            kind: 'rtc.send',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            scope: { tenant: 'tenant-1' },
            roomRef: { type: 'group', id: 'group-1' },
            minSnapshotVersion: 42
        });
    });

    it('wraps WebSocket broadcast sends with group delivery metadata', () => {
        const [command] = buildManualWorkbenchCommands(
            'send',
            {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'ws',
                deliveryMode: 'broadcast'
            },
            { text: 'hello' },
            9
        );

        expect(command).toMatchObject({
            kind: 'ws.send',
            commandId: 'manual-ws-send-broadcast-9',
            data: {
                groupId: 'rallar-black-box-room',
                topic: 'room.manual.message',
                deliveryMode: 'broadcast',
                targets: [],
                payload: {
                    text: 'hello'
                }
            }
        });
    });

    it('builds join as configure plus transport connection command', () => {
        const commands = buildManualWorkbenchCommands(
            'join',
            {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                providerMode: 'browser-rallar',
                transport: 'ws',
                wsUrl: 'wss://control.example.test/group'
            },
            {},
            10
        );

        expect(commands.map((command) => command.kind)).toEqual(['configure', 'ws.open']);
        expect(commands[0].commandId).toBe('manual-configure-10');
        expect(commands[0]).toMatchObject({
            config: {
                control: {
                    providerMode: 'browser-rallar'
                },
                defaults: {
                    providerMode: 'browser-rallar'
                }
            }
        });
        expect(commands[1]).toMatchObject({
            commandId: 'manual-ws-open-11',
            url: 'wss://control.example.test/group'
        });
    });

    it('builds real RTC join as configure, group create, and connect', () => {
        const commands = buildManualWorkbenchCommands(
            'join',
            {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                providerMode: 'browser-rallar',
                transport: 'realtime',
                groupId: 'room-from-manual'
            },
            {},
            20
        );

        expect(commands.map((command) => command.kind)).toEqual(['configure', 'http.request', 'rtc.connect']);
        expect(commands[1]).toMatchObject({
            commandId: 'manual-group-create-21',
            request: {
                method: 'POST',
                path: expect.stringMatching(
                    new RegExp(
                        `^/api/state/apps/${DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId}` +
                            '/workspaces/default/groups/requests/[^/]+$'
                    )
                ),
                body: {
                    groupId: 'room-from-manual',
                    kind: 'room',
                    joinMode: 'open'
                }
            }
        });
        expect(commands[2]).toMatchObject({
            commandId: 'manual-rtc-connect-22',
            roomId: 'room-from-manual'
        });
        const repeatedAction = buildManualWorkbenchCommands(
            'join',
            {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                providerMode: 'browser-rallar',
                transport: 'realtime',
                groupId: 'room-from-manual'
            },
            {},
            20
        );
        expect((repeatedAction[1] as { request?: { path?: string; }; }).request?.path)
            .not.toBe((commands[1] as { request?: { path?: string; }; }).request?.path);
    });

    it('builds RTC delivery matrix commands for direct, multicast, and broadcast', () => {
        const commands = manualRtcDeliveryMatrixCommands(
            {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'realtime',
                targetClient: 'bob-peer',
                multicastClients: 'bob-peer, charlie-peer'
            },
            { text: 'matrix' },
            40,
            'realtime'
        );

        expect(commands.map((command) => command.commandId)).toEqual([
            'manual-configure-40',
            'manual-rtc-connect-41',
            'manual-rtc-send-direct-42',
            'manual-rtc-send-multicast-43',
            'manual-rtc-send-broadcast-44'
        ]);
        expect(commands.map((command) => command.kind)).toEqual([
            'configure',
            'rtc.connect',
            'rtc.send',
            'rtc.send',
            'rtc.send'
        ]);
        expect(commands[2]).toMatchObject({
            metadata: {
                manual: {
                    deliveryMode: 'direct',
                    targets: ['bob-peer']
                }
            }
        });
        expect(commands[3]).toMatchObject({
            metadata: {
                manual: {
                    deliveryMode: 'multicast',
                    targets: ['bob-peer', 'charlie-peer']
                }
            }
        });
        expect(commands[4]).toMatchObject({
            metadata: {
                manual: {
                    deliveryMode: 'broadcast',
                    targets: []
                }
            }
        });
    });

    it('generates RTC negative recipe entries for NACK and delivery failures', () => {
        const recipe = JSON.parse(manualRtcNegativeRecipeSnippet({
            ...DEFAULT_MANUAL_WORKBENCH_VALUES,
            transport: 'messages.rtc'
        }, { text: 'negative' })) as {
            continueOnFailure: boolean;
            commands: Array<{ commandId: string; metadata?: Record<string, unknown>; expect?: unknown; }>;
        };

        expect(recipe.continueOnFailure).toBe(true);
        expect(recipe.commands.map((command) => command.commandId)).toContain(
            'manual-rtc-negative-missing-peer'
        );
        expect(recipe.commands.map((command) => command.commandId)).toContain(
            'manual-rtc-nack-not-yet-in-sync-9'
        );
        expect(recipe.commands.find((command) => command.commandId === 'manual-rtc-nack-not-yet-in-sync-9')).toMatchObject({
            metadata: {
                negativeCase: 'not-yet-in-sync',
                expectedOutcome: 'nack'
            }
        });
        for (const command of recipe.commands) {
            expect(command.expect, command.commandId).toBeUndefined();
        }
    });

    it('carries browser-rallar auth defaults into manual configure commands', () => {
        const [command] = buildManualWorkbenchCommands(
            'configure',
            {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                providerMode: 'browser-rallar',
                rallarUsername: 'alice',
                rallarPassword: 'secret',
                rallarRegister: true,
                rallarLogoutOnClose: true,
                rallarLeaveRoomOnClose: false
            },
            {},
            12
        );

        expect(command).toMatchObject({
            kind: 'configure',
            config: {
                rallar: {
                    username: 'alice',
                    password: 'secret',
                    register: true,
                    logoutOnClose: true,
                    leaveRoomOnClose: false
                },
                redaction: {
                    secretValues: ['secret']
                }
            }
        });
    });

    it('validates payload JSON before command execution', () => {
        expect(parseManualPayload('{"ok":true}')).toEqual({
            ok: true,
            value: {
                ok: true
            }
        });

        expect(parseManualPayload('{')).toMatchObject({
            ok: false
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
                        text: 'hello'
                    }
                }
            } satisfies RallarBlackBoxTestEvent
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
                    text: 'hello'
                }
            }
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
                    commandId: 'manual-health-1'
                }
            ]
        };

        expect(JSON.parse(manualRecipeSnippet([entry]))).toMatchObject({
            recipeId: 'manual-workbench-recipe',
            commands: [
                {
                    kind: 'health',
                    commandId: 'manual-health-1'
                }
            ]
        });
    });
});
