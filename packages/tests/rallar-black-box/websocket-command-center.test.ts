import { describe, expect, it } from 'vitest';
import { webSocketCommandCenterRecipe } from '../../../apps/rallar-black-box/src/diagnostics/websocket/evidence/websocket-recipes.ts';
import {
    isWebSocketJsonObject,
    normalizeWebSocketJsonValue,
    parseWebSocketJsonValue
} from '../../../apps/rallar-black-box/src/diagnostics/websocket/normalize-websocket-json-value.ts';
import { deriveWebSocketDiagnostics } from '../../../apps/rallar-black-box/src/diagnostics/websocket/state/derive-web-socket-diagnostics.ts';
import type {
    WebSocketCommandCenterValues,
    WebSocketDiagnostic,
    WebSocketJsonValue
} from '../../../apps/rallar-black-box/src/diagnostics/websocket/websocket-contracts.ts';
import {
    DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID,
    WEBSOCKET_PAYLOAD_PRESETS,
    webSocketPayloadPresetById,
    webSocketPayloadPresetText
} from '../../../apps/rallar-black-box/src/diagnostics/websocket/websocket-presets.ts';
import {
    defaultWebSocketScope,
    defaultWebSocketTopicId,
    defaultWebSocketTypeId,
    defaultWebSocketValuesFromContext,
    webSocketRoutePreview
} from '../../../apps/rallar-black-box/src/diagnostics/websocket/websocket-routing.ts';
import { defaultWebSocketApiUrl, resolveWebSocketUrlTemplate } from '../../../apps/rallar-black-box/src/diagnostics/websocket/websocket-url-routing.ts';
import { resolveRallarBlackBoxBootstrapConfig } from '../../shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type { RallarBlackBoxTestEvent, RallarBlackBoxTestResult, RallarBlackBoxTestState } from '../../shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '../../shared/api/api-config.ts';

interface WebSocketRecipeCommand {
    readonly kind: string;
    readonly commandId: string;
    readonly data?: WebSocketJsonValue;
    readonly [key: string]: WebSocketJsonValue | undefined;
}

interface WebSocketRecipeDocument {
    readonly recipeId?: string;
    readonly commands: readonly WebSocketRecipeCommand[];
}

interface CircularDiagnosticPayload {
    readonly label: string;
    self?: CircularDiagnosticPayload;
}

const bootstrap = resolveRallarBlackBoxBootstrapConfig(
    '?apiBaseUrl=https%3A%2F%2Fbootstrap.example%2Fapi&applicationId=bootstrap-app&workspaceId=bootstrap-workspace&roomId=bootstrap-room&actor=bootstrap-actor&sessionId=bootstrap-session',
    {},
    ''
);

const authSession: AuthSession = {
    clientId: 'client-1',
    accessToken: 'access-secret',
    username: 'alice',
    sessionId: 'session/with spaces',
    expiresAtEpochMs: 9_999
};

const values: WebSocketCommandCenterValues = {
    apiBaseUrl: 'https://api.example.test/root',
    connection: 'primary-ws',
    applicationId: 'black-box-app',
    workspaceId: 'workspace-a',
    groupId: 'group-a',
    wsScope: 'room',
    typeId: 'room.message',
    topicId: 'room.chat',
    contextId: 'context-a',
    resourceId: 'resource-a',
    wsUrl: 'wss://api.example.test/api/ws/session?ticket=ticket',
    protocols: ' json, , rallar.v1 ',
    payloadText: '{"text":"hello"}',
    timeoutMs: 2_500,
    closeCode: 1001,
    closeReason: 'done'
};

function readWebSocketRecipe(recipeText: string): WebSocketRecipeDocument {
    const value = JSON.parse(recipeText) as WebSocketJsonValue;
    if (!isWebSocketJsonObject(value) || !Array.isArray(value.commands)) {
        throw new Error('Expected a WebSocket recipe with commands.');
    }
    const recipeId = typeof value.recipeId === 'string' ? value.recipeId : undefined;
    return {
        recipeId,
        commands: value.commands.map(readWebSocketRecipeCommand)
    };
}

function readWebSocketRecipeCommand(value: WebSocketJsonValue): WebSocketRecipeCommand {
    if (
        !isWebSocketJsonObject(value) ||
        typeof value.kind !== 'string' ||
        typeof value.commandId !== 'string'
    ) {
        throw new Error('Expected a WebSocket recipe command.');
    }
    return {
        ...value,
        kind: value.kind,
        commandId: value.commandId
    };
}

function event(
    eventId: string,
    atEpochMs: number,
    overrides: Partial<RallarBlackBoxTestEvent> = {}
): RallarBlackBoxTestEvent {
    return {
        eventId,
        kind: 'diagnostic',
        topic: `rallar.bb.ws.${eventId}`,
        atEpochMs,
        connection: 'primary-ws',
        transport: 'ws',
        ...overrides
    };
}

function result(
    commandId: string,
    overrides: Partial<RallarBlackBoxTestResult> = {}
): RallarBlackBoxTestResult {
    return {
        commandId,
        kind: 'ws.send',
        status: 'ok',
        ok: true,
        startedAtEpochMs: 100,
        endedAtEpochMs: 110,
        durationMs: 10,
        value: { connection: 'primary-ws' },
        ...overrides
    };
}

describe('WebSocket JSON normalization', () => {
    it('normalizes unsupported and circular diagnostic values without propagating them', () => {
        const circular: CircularDiagnosticPayload = { label: 'cycle' };
        circular.self = circular;

        expect(normalizeWebSocketJsonValue({ count: 1n, circular })).toEqual({
            count: '1',
            circular: { label: 'cycle', self: '[Circular]' }
        });
    });

    it('returns a typed JSON value or a normalized parse failure', () => {
        expect(parseWebSocketJsonValue('{"message":"hello"}')).toEqual({
            ok: true,
            value: { message: 'hello' }
        });
        expect(parseWebSocketJsonValue('{')).toMatchObject({ ok: false });
    });
});

function state(
    events: readonly RallarBlackBoxTestEvent[] = [],
    commandHistory: readonly RallarBlackBoxTestResult[] = []
): RallarBlackBoxTestState {
    return {
        status: 'completed',
        currentConfig: {
            roomId: 'group-a',
            transport: 'ws',
            defaults: { connection: 'primary-ws' }
        },
        commandHistory,
        events,
        failures: commandHistory.filter((entry) => !entry.ok),
        resultCache: {}
    };
}

describe('WebSocket command-center presets and routing', () => {
    it('keeps the copied payload presets, defaults, and unknown-id fallback deterministic', () => {
        expect(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID).toBe('group-message');
        expect(WEBSOCKET_PAYLOAD_PRESETS.map((preset) => preset.presetId)).toEqual([
            'ping',
            'group-message',
            'parity-probe'
        ]);
        expect(defaultWebSocketScope()).toBe('room');
        expect(defaultWebSocketTypeId()).toBe('room.manual.message');
        expect(defaultWebSocketTopicId()).toBe('room.manual.message');
        expect(webSocketPayloadPresetById('missing').presetId).toBe('ping');
        expect(webSocketPayloadPresetText('missing')).toBeUndefined();
        expect(JSON.parse(webSocketPayloadPresetText('group-message') ?? '')).toEqual({
            deliveryMode: 'broadcast',
            text: 'hello from rallar-black-box'
        });
    });

    it('derives WebSocket endpoints and encodes every route-template credential', () => {
        expect(defaultWebSocketApiUrl('https://api.example.test/base?old=1')).toBe(
            'wss://api.example.test/api/ws/%7Bauth.sessionId%7D?ticket={auth.wsTicket}'
        );
        expect(defaultWebSocketApiUrl('http://localhost:9090')).toBe(
            'ws://localhost:9090/api/ws/%7Bauth.sessionId%7D?ticket={auth.wsTicket}'
        );
        expect(defaultWebSocketApiUrl('not a URL')).toBe(
            'ws://localhost:8080/api/ws/{auth.sessionId}?ticket={auth.wsTicket}'
        );

        expect(
            resolveWebSocketUrlTemplate({
                template: '{config.wsBaseUrl}/api/ws/{auth.sessionId}?ticket={auth.wsTicket}',
                apiBaseUrl: 'https://api.example.test/nested?old=1#hash',
                authSession,
                ticket: {
                    ticket: 'ticket/? +',
                    sessionId: 'ticket-session',
                    expiresAtEpochMs: 8_000,
                    issuedAtEpochMs: 7_000
                }
            })
        ).toBe(
            'wss://api.example.test/api/ws/session%2Fwith%20spaces?ticket=ticket%2F%3F%20%2B'
        );
        expect(
            resolveWebSocketUrlTemplate({
                template: '{config.wsBaseUrl}/{auth.sessionId}/{auth.wsTicket}',
                apiBaseUrl: 'invalid',
                authSession: undefined,
                ticket: undefined
            })
        ).toBe('ws://localhost:8080//');
    });

    it('preserves context precedence and the all-scope empty-context fallback', () => {
        expect(
            defaultWebSocketValuesFromContext(
                {
                    apiBaseUrl: 'https://global.example',
                    applicationId: 'global-app',
                    workspaceId: 'global-workspace',
                    clientId: 'global-client',
                    sessionId: 'global-session',
                    roomId: 'global-room'
                },
                {
                    apiBaseUrl: 'https://config.example',
                    roomId: 'config-room',
                    rallar: {
                        applicationId: 'config-app',
                        workspaceId: 'config-workspace'
                    }
                },
                bootstrap
            )
        ).toEqual({
            apiBaseUrl: 'https://global.example',
            applicationId: 'global-app',
            workspaceId: 'global-workspace',
            groupId: 'global-room',
            contextId: 'global-room'
        });

        expect(
            defaultWebSocketValuesFromContext(
                undefined,
                { apiBaseUrl: '', roomId: '', rallar: {} },
                { ...bootstrap, roomId: '' }
            )
        ).toMatchObject({
            applicationId: 'rallar-black-box',
            workspaceId: 'default',
            groupId: '',
            contextId: 'all'
        });
    });

    it('normalizes untyped payloads while preserving typed routing overrides through copied recipes', () => {
        const recipeFor = (
            nextValues: WebSocketCommandCenterValues,
            payload: WebSocketJsonValue
        ): WebSocketRecipeCommand => {
            const recipe = readWebSocketRecipe(webSocketCommandCenterRecipe({
                values: nextValues,
                payload,
                bootstrap,
                providerMode: 'real',
                sequence: 1
            }));
            const sendCommand = recipe.commands.find((command) => command.kind === 'ws.send');
            if (!sendCommand) {
                throw new Error('Expected copied recipe to include a WebSocket send command.');
            }
            return sendCommand;
        };

        expect(recipeFor(values, { text: 'hello' }).data).toEqual({
            payload: { text: 'hello' },
            applicationId: 'black-box-app',
            workspaceId: 'workspace-a',
            roomId: 'group-a',
            groupId: 'group-a',
            scope: 'room',
            typeId: 'room.message',
            topicId: 'room.chat',
            contextId: 'context-a',
            resourceId: 'resource-a'
        });
        expect(
            recipeFor(
                { ...values, wsScope: 'all', groupId: 'ignored-group' },
                {
                    payload: 'typed',
                    scope: 'world',
                    groupId: 'explicit-group',
                    typeId: 'override-type',
                    contextId: '',
                    resourceId: 'explicit-resource'
                }
            ).data
        ).toEqual({
            payload: 'typed',
            scope: 'world',
            groupId: 'explicit-group',
            typeId: 'override-type',
            contextId: 'context-a',
            resourceId: 'explicit-resource',
            applicationId: 'black-box-app',
            workspaceId: 'workspace-a',
            roomId: 'explicit-group',
            topicId: 'room.chat'
        });
    });

    it('derives destination, selector, transport, and action copy for every guardrail branch', () => {
        const diagnostics: WebSocketDiagnostic = {
            readyState: 'open',
            status: 'open',
            statusLabel: 'open',
            inboundCount: 0,
            outboundCount: 0,
            errorCount: 0,
            recentEvents: [],
            receivedMessages: []
        };
        const browserStatus = {
            signalingLabel: 'open',
            signalingTone: 'good',
            signalingDetail: '-',
            rtcLabel: 'not observed',
            rtcTone: 'muted',
            rtcDetail: '-',
            rtcGroup: '-',
            rtcConnection: '-',
            rtcTransport: '-',
            peerSummary: 'ready 0 / active 0 / known 0'
        };

        expect(
            webSocketRoutePreview({
                values,
                diagnostics,
                providerMode: 'browser-rallar',
                browserStatus
            })
        ).toEqual({
            destination: 'Group group-a',
            destinationDetail: 'Application black-box-app / workspace workspace-a',
            selector: 'room.chat / room.message',
            selectorDetail: 'Context context-a',
            transport: 'Rallar app WS',
            transportDetail: 'Uses open Rallar signaling for primary-ws',
            sendLabel: 'Send JSON to group group-a'
        });
        expect(
            webSocketRoutePreview({
                values: {
                    ...values,
                    groupId: ' ',
                    topicId: ' ',
                    typeId: ' ',
                    contextId: ' '
                },
                diagnostics: { ...diagnostics, status: 'closed' },
                providerMode: 'real',
                browserStatus
            })
        ).toMatchObject({
            destination: 'No group selected',
            destinationDetail: 'Room-scoped messages need a Group before send.',
            selector: '* / -',
            selectorDetail: 'Context room',
            transport: 'No open WS',
            sendLabel: 'Send JSON to group'
        });
        expect(
            webSocketRoutePreview({
                values: { ...values, wsScope: 'all' },
                diagnostics: { ...diagnostics, status: 'idle' },
                providerMode: 'simulated',
                browserStatus
            })
        ).toMatchObject({
            destination: 'All WS subscribers',
            destinationDetail: 'Group is ignored for this send.',
            transport: 'Simulated WebSocket',
            sendLabel: 'Send JSON to all'
        });
        expect(
            webSocketRoutePreview({
                values: { ...values, wsScope: 'world' },
                diagnostics,
                providerMode: 'real',
                browserStatus
            })
        ).toMatchObject({
            destination: 'World scope',
            destinationDetail: 'Uses Rallar world scope; Group is ignored.',
            transport: 'Raw WebSocket',
            sendLabel: 'Send JSON to world'
        });
    });
});

describe('WebSocket command-center copied recipes', () => {
    it('builds configure/open/send/close commands without changing backend contracts', () => {
        const recipe = readWebSocketRecipe(webSocketCommandCenterRecipe({
            values: { ...values, closeCode: Number.NaN },
            bootstrap,
            providerMode: 'browser-rallar',
            authSession,
            sequence: 7,
            payload: {
                deliveryMode: 'broadcast',
                text: 'hello from rallar-black-box'
            }
        }));

        expect(recipe.commands[0]).toMatchObject({
            kind: 'configure',
            commandId: 'ws-configure-7',
            config: {
                runId: 'websocket-command-center-7',
                actor: 'alice',
                sessionId: 'session/with spaces',
                roomId: 'group-a',
                transport: 'ws',
                rallar: {
                    username: 'alice',
                    restoreSession: true,
                    applicationId: 'black-box-app',
                    workspaceId: 'workspace-a',
                    roomRef: {
                        applicationId: 'black-box-app',
                        workspaceId: 'workspace-a',
                        groupId: 'group-a'
                    },
                    typeId: 'room.message',
                    topicId: 'room.chat'
                },
                control: {
                    mode: 'websocket-command-center',
                    providerMode: 'browser-rallar',
                    protocolVersion: 1,
                    connected: false
                }
            }
        });
        expect(recipe.commands[1]).toEqual({
            kind: 'ws.open',
            commandId: 'ws-open-8',
            label: 'Open WebSocket',
            connection: 'primary-ws',
            url: values.wsUrl,
            protocols: ['json', 'rallar.v1'],
            timeoutMs: 2_500
        });
        expect(recipe.commands[2]).toMatchObject({
            kind: 'ws.send',
            commandId: 'ws-send-9',
            connection: 'primary-ws',
            data: {
                payload: {
                    deliveryMode: 'broadcast',
                    text: 'hello from rallar-black-box'
                },
                roomId: 'group-a',
                scope: 'room'
            }
        });
        expect(recipe.commands[3]).toEqual({
            kind: 'ws.close',
            commandId: 'ws-close-11',
            label: 'Close WebSocket',
            connection: 'primary-ws',
            code: 1000,
            reason: 'done',
            timeoutMs: 2_500
        });
    });

    it('keeps copied recipe command order, parity commands, and secret redaction exact', () => {
        const recipe = readWebSocketRecipe(webSocketCommandCenterRecipe({
            values,
            payload: { accessToken: 'access-secret', text: 'parity' },
            bootstrap: { ...bootstrap, rallarPassword: 'password-secret' },
            providerMode: 'browser-rallar',
            authSession,
            sequence: 20,
            includeRtcParity: true
        }));

        expect(recipe.recipeId).toBe(
            'rallar-websocket-rtc-parity-command-center'
        );
        expect(recipe.commands.map((command) => command.kind)).toEqual([
            'configure',
            'ws.open',
            'ws.send',
            'rtc.connect',
            'rtc.send',
            'ws.close'
        ]);
        expect(recipe.commands.map((command) => command.commandId)).toEqual([
            'ws-configure-20',
            'ws-open-21',
            'ws-send-22',
            'ws-rtc-parity-connect-23',
            'ws-rtc-parity-send-24',
            'ws-close-26'
        ]);
        expect(JSON.stringify(recipe)).not.toContain('access-secret');
        expect(JSON.stringify(recipe)).not.toContain('password-secret');
    });
});

describe('WebSocket command-center diagnostics', () => {
    it('preserves verdict precedence, connection filtering, counters, and nested messages', () => {
        const diagnostics = deriveWebSocketDiagnostics(
            state(
                [
                    event('opened', 100, {
                        topic: 'rallar.bb.ws.opened',
                        payload: { readyState: 'open' }
                    }),
                    event('other', 150, {
                        connection: 'other-ws',
                        severity: 'error',
                        topic: 'rallar.bb.ws.error'
                    }),
                    event('message', 200, {
                        kind: 'message',
                        payload: {
                            senderId: 'outer-sender',
                            data: {
                                senderId: 'inner-sender',
                                groupId: 'nested-group',
                                typeId: 'nested-type',
                                topicId: 'nested-topic',
                                contextId: 'nested-context',
                                resourceId: 'nested-resource',
                                payload: { text: 'received' }
                            }
                        }
                    }),
                    event('closed', 300, {
                        topic: 'rallar.bb.ws.closed',
                        payload: { code: 1001, reason: 'closed first' }
                    }),
                    event('error', 400, {
                        topic: 'rallar.bb.ws.error',
                        severity: 'error'
                    })
                ],
                [
                    result('send-ok'),
                    result('send-other', {
                        value: { connection: 'other-ws' }
                    }),
                    result('open-failed', {
                        kind: 'ws.open',
                        status: 'failed',
                        ok: false
                    })
                ]
            ),
            'primary-ws'
        );

        expect(diagnostics).toMatchObject({
            readyState: 'open',
            status: 'error',
            statusLabel: 'error',
            lastOpenAtEpochMs: 100,
            lastCloseAtEpochMs: 300,
            closeCode: 1001,
            closeReason: 'closed first',
            inboundCount: 1,
            outboundCount: 1,
            errorCount: 2
        });
        expect(diagnostics.recentEvents.map((entry) => entry.eventId)).toEqual([
            'opened',
            'message',
            'closed',
            'error'
        ]);
        expect(diagnostics.receivedMessages).toEqual([
            {
                eventId: 'message',
                atEpochMs: 200,
                senderId: 'outer-sender',
                roomId: 'nested-group',
                typeId: 'nested-type',
                topicId: 'nested-topic',
                contextId: 'nested-context',
                resourceId: 'nested-resource',
                payload: { text: 'received' }
            }
        ]);
    });

    it('keeps simulated/open/closed/idle verdict order and the most recent sixteen rows', () => {
        expect(deriveWebSocketDiagnostics(state(), 'primary-ws').status).toBe('idle');
        expect(
            deriveWebSocketDiagnostics(
                state([
                    event('closed', 100, { topic: 'rallar.bb.ws.closed' }),
                    event('simulated', 200, {
                        topic: 'rallar.bb.ws.open_skipped'
                    })
                ]),
                'primary-ws'
            ).status
        ).toBe('simulated');
        expect(
            deriveWebSocketDiagnostics(
                state([
                    event('closed', 100, { topic: 'rallar.bb.ws.closed' }),
                    event('opened', 200, { topic: 'rallar.bb.ws.opened' })
                ]),
                'primary-ws'
            ).status
        ).toBe('open');
        expect(
            deriveWebSocketDiagnostics(
                state([
                    event('error', 100, {
                        topic: 'rallar.bb.ws.error',
                        severity: 'error'
                    }),
                    event('closed', 200, { topic: 'rallar.bb.ws.closed' })
                ]),
                'primary-ws'
            ).status
        ).toBe('closed');
        expect(
            deriveWebSocketDiagnostics(
                state([
                    event('simulated', 100, {
                        topic: 'rallar.bb.ws.open_skipped'
                    }),
                    event('error', 200, {
                        topic: 'rallar.bb.ws.error',
                        severity: 'error'
                    })
                ]),
                'primary-ws'
            ).status
        ).toBe('error');
        expect(
            deriveWebSocketDiagnostics(
                state([
                    event('closed', 200, { topic: 'rallar.bb.ws.closed' }),
                    event('opened', 200, { topic: 'rallar.bb.ws.opened' })
                ]),
                'primary-ws'
            ).status
        ).toBe('open');

        const ordered = deriveWebSocketDiagnostics(
            state(
                Array.from({ length: 18 }, (_, index) => event(`ordered-${index}`, index))
            ),
            ''
        );
        expect(ordered.recentEvents.map((entry) => entry.eventId)).toEqual(
            Array.from({ length: 16 }, (_, index) => `ordered-${index + 2}`)
        );
    });
});
