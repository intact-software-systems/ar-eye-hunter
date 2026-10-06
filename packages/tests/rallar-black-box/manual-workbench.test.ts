import {
    describe,
    expect,
    it
} from 'vitest';

import type { RallarBlackBoxTestEvent } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { RtcSignalingDiagnostics } from '../../shared/webrtc/rtc-signaling-diagnostics.ts';

import {
    decodeManualPayloadText,
    DEFAULT_MANUAL_WORKBENCH_VALUES,
    toManualReceivedMessages,
    toManualRecipeText,
    type ManualActionHistoryEntry,
    type ManualWorkbenchValues
} from '../../../apps/rallar-black-box/src/manual-workbench.ts';
import {
    toManualRtcDeliveryMatrixCommands,
    toManualRtcNegativeRecipeText
} from '../../../apps/rallar-black-box/src/manual-workbench/manual-rtc-probe-commands.ts';
import { toManualWorkbenchCommands } from '../../../apps/rallar-black-box/src/manual-workbench/manual-workbench-commands.ts';
import { validateSchemaAuthoringText } from '../../../apps/rallar-black-box/src/schema-authoring.ts';

describe('rallar-black-box manual workbench helpers', () => {
    it('builds direct realtime sends with explicit peer targets', () => {
        const [command] = toManualWorkbenchCommands({
            action: 'send',
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'realtime',
                deliveryMode: 'direct',
                targetClient: 'bob-peer'
            },
            payload: { text: 'hello' },
            sequence: 7,
            requestId: crypto.randomUUID()
        });

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
        const [command] = toManualWorkbenchCommands({
            action: 'send',
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'messages.rtc',
                deliveryMode: 'multicast',
                multicastClients: 'bob-peer, charlie-peer',
                typeId: 'chat',
                topicId: 'room-message'
            },
            payload: { text: 'hello' },
            sequence: 8,
            requestId: crypto.randomUUID()
        });

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
            providerMode: 'browser-rallar',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            scopeText: '{"tenant":"tenant-1"}',
            roomRefText: '{"applicationId":"explicit-app","workspaceId":"explicit-workspace","groupId":"explicit-group"}',
            minSnapshotVersion: 42,
            transport: 'messages.rtc'
        } satisfies ManualWorkbenchValues;
        const commands = toManualWorkbenchCommands({
            action: 'join',
            values: values,
            payload: {},
            sequence: 20,
            requestId: crypto.randomUUID()
        });
        const [send] = toManualWorkbenchCommands({
            action: 'send',
            values: values,
            payload: { text: 'hello' },
            sequence: 30,
            requestId: crypto.randomUUID()
        });

        expect(commands[0]).toMatchObject({
            kind: 'configure',
            config: {
                defaults: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    scope: { tenant: 'tenant-1' },
                    roomRef: { applicationId: 'explicit-app', workspaceId: 'explicit-workspace', groupId: 'explicit-group' },
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
            roomRef: { applicationId: 'explicit-app', workspaceId: 'explicit-workspace', groupId: 'explicit-group' },
            minSnapshotVersion: 42
        });
        expect(send).toMatchObject({
            kind: 'rtc.send',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            scope: { tenant: 'tenant-1' },
            roomRef: { applicationId: 'explicit-app', workspaceId: 'explicit-workspace', groupId: 'explicit-group' },
            minSnapshotVersion: 42
        });
    });

    it('qualifies the default room reference from visible application, workspace and group values', () => {
        const values = {
            ...DEFAULT_MANUAL_WORKBENCH_VALUES,
            providerMode: 'browser-rallar',
            applicationId: 'visible-app',
            workspaceId: 'visible-workspace',
            groupId: 'visible-group'
        } satisfies ManualWorkbenchValues;
        const [configure, , connect] = toManualWorkbenchCommands({
            action: 'join',
            values,
            payload: {},
            sequence: 40,
            requestId: 'qualified-default-room'
        });
        const roomRef = {
            applicationId: 'visible-app',
            workspaceId: 'visible-workspace',
            groupId: 'visible-group'
        };

        expect(configure).toMatchObject({
            kind: 'configure',
            config: { defaults: { roomRef }, rallar: { roomRef } }
        });
        expect(connect).toMatchObject({ kind: 'rtc.connect', roomRef });
    });

    it('wraps WebSocket broadcast sends with group delivery metadata', () => {
        const [command] = toManualWorkbenchCommands({
            action: 'send',
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'ws',
                deliveryMode: 'broadcast'
            },
            payload: { text: 'hello' },
            sequence: 9,
            requestId: crypto.randomUUID()
        });

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
        const commands = toManualWorkbenchCommands({
            action: 'join',
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                providerMode: 'browser-rallar',
                transport: 'ws',
                wsUrl: 'wss://control.example.test/group'
            },
            payload: {},
            sequence: 10,
            requestId: crypto.randomUUID()
        });

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
        const commands = toManualWorkbenchCommands({
            action: 'join',
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                providerMode: 'browser-rallar',
                transport: 'realtime',
                groupId: 'room-from-manual'
            },
            payload: {},
            sequence: 20,
            requestId: crypto.randomUUID()
        });

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
        const repeatedAction = toManualWorkbenchCommands({
            action: 'join',
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                providerMode: 'browser-rallar',
                transport: 'realtime',
                groupId: 'room-from-manual'
            },
            payload: {},
            sequence: 20,
            requestId: crypto.randomUUID()
        });
        const firstGroupCreate = commands.find((command) => command.kind === 'http.request');
        const repeatedGroupCreate = repeatedAction.find((command) => command.kind === 'http.request');
        expect(firstGroupCreate).toBeDefined();
        expect(repeatedGroupCreate).toBeDefined();
        expect(repeatedGroupCreate?.request.path).not.toBe(firstGroupCreate?.request.path);
    });

    it.each<RtcSignalingDiagnostics.CaptureMode>(['off', 'signaling', 'native'])(
        'carries explicit %s capture on direct Connect without Configure',
        (rtcCaptureMode) => {
            const values = { ...DEFAULT_MANUAL_WORKBENCH_VALUES, rtcCaptureMode };
            const commands = toManualWorkbenchCommands({
                action: 'connect',
                values,
                payload: {},
                sequence: 1,
                requestId: 'manual-capture-connect'
            });

            expect(commands).toMatchObject([
                { kind: 'rtc.connect', rallar: { rtcCaptureMode } }
            ]);
            expect(commands).toHaveLength(1);
        }
    );

    it('carries explicit Off on the RTC connection submitted by Join', () => {
        const rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode = 'off';
        const values = {
            ...DEFAULT_MANUAL_WORKBENCH_VALUES,
            providerMode: 'browser-rallar',
            rtcCaptureMode
        } satisfies ManualWorkbenchValues & { readonly rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode; };
        const commands = toManualWorkbenchCommands({
            action: 'join',
            values,
            payload: {},
            sequence: 1,
            requestId: 'manual-capture-join'
        });

        expect(commands.find((command) => command.kind === 'rtc.connect')).toMatchObject({
            rallar: { rtcCaptureMode: 'off' }
        });
    });

    it('builds RTC delivery matrix commands for direct, multicast, and broadcast', () => {
        const commands = toManualRtcDeliveryMatrixCommands({
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'realtime',
                targetClient: 'bob-peer',
                multicastClients: 'bob-peer, charlie-peer'
            },
            payload: { text: 'matrix' },
            sequence: 40,
            transport: 'realtime',
            requestId: crypto.randomUUID()
        });

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
        const recipe = validateSchemaAuthoringText(
            'recipe',
            toManualRtcNegativeRecipeText({
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                transport: 'messages.rtc'
            }, { text: 'negative' })
        ).parsed;

        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe)).toEqual({ ok: true, errors: [] });
        expect(recipe).toMatchObject({
            continueOnFailure: true,
            commands: expect.arrayContaining([
                expect.objectContaining({ commandId: 'manual-rtc-negative-missing-peer' }),
                expect.objectContaining({
                    commandId: 'manual-rtc-nack-not-yet-in-sync-9',
                    metadata: expect.objectContaining({ negativeCase: 'not-yet-in-sync', expectedOutcome: 'nack' })
                })
            ])
        });
        expect(recipe).not.toMatchObject({
            commands: expect.arrayContaining([expect.objectContaining({ expect: expect.anything() })])
        });
    });

    it('carries browser-rallar auth defaults into manual configure commands', () => {
        const [command] = toManualWorkbenchCommands({
            action: 'configure',
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                providerMode: 'browser-rallar',
                rallarUsername: 'alice',
                rallarPassword: 'secret',
                rallarRegister: true,
                rallarLogoutOnClose: true,
                rallarLeaveRoomOnClose: false
            },
            payload: {},
            sequence: 12,
            requestId: crypto.randomUUID()
        });

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
        expect(decodeManualPayloadText('{"ok":true}').foldRight((value) => value)).toEqual({ ok: true });
        expect(decodeManualPayloadText('{').fold((error) => typeof error, () => 'decoded')).toBe('string');
    });

    it('derives received inbox rows from runtime message events', () => {
        const messages = toManualReceivedMessages([
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

        const exported = JSON.parse(toManualRecipeText([entry]));
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, exported)).toEqual({ ok: true, errors: [] });
        expect(exported).toMatchObject({
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
