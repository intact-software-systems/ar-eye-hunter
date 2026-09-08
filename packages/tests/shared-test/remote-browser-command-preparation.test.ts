import {
    describe,
    expect,
    it
} from 'vitest';

import { executeRemoteHttpInteraction } from '../../shared-test/black-box-runner/execution/execute-remote-http-interaction.ts';
import { executeRemoteWsInteraction } from '../../shared-test/black-box-runner/execution/remote-browser-websocket-interaction.ts';
import { createRallarRemoteBrowserRtcProvider } from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';
import {
    toCloseCommand,
    toConnectCommand,
    toCrdtCommand,
    toHealthCommand,
    toRallarRemoteBrowserCommandId,
    toSendCommand
} from '../../shared-test/black-box-runner/remote-browser/remote-browser-commands.ts';

const opaque = { toString: 0 };

describe('remote browser command preparation', () => {
    it.each(
        [
            ['connect', toConnectCommand],
            ['send', toSendCommand],
            ['close', toCloseCommand],
            ['health', toHealthCommand]
        ] as const
    )('rejects malformed %s controls before claiming a command', (_action, prepare) => {
        const result = prepare('command', { request: { timeoutMs: opaque } });
        expect(result.left).toBeInstanceOf(Error);
        expect(result.right).toBeUndefined();
    });

    it.each([
        { action: opaque },
        { action: 'open', name: 'document', persist: opaque },
        { action: 'sync', handle: 'document', transport: opaque },
        { action: 'wait', handle: 'document', conditions: [{ source: 'value', operator: opaque }] }
    ])('returns an Either failure for malformed CRDT controls %j', (request) => {
        const result = toCrdtCommand('command', { request });
        expect(result.left).toBeInstanceOf(Error);
        expect(result.right).toBeUndefined();
    });

    it.each(['connection', 'actor', 'scenarioExecutionNumber', 'interactionExecutionNumber', 'repeatIndex'])(
        'rejects opaque fallback identity field %s without coercion',
        (field) => {
            const result = toRallarRemoteBrowserCommandId('connect', { request: { [field]: opaque } });
            expect(result.left).toBeInstanceOf(Error);
            expect(result.right).toBeUndefined();
        }
    );

    it('rejects an opaque connect actor even when a connection name is explicit', () => {
        const result = toConnectCommand('command', { request: { connection: 'room', actor: opaque } });
        expect(result.left).toBeInstanceOf(Error);
        expect(result.right).toBeUndefined();
    });

    it.each([
        { rallar: opaque, minSnapshotVersion: null },
        { applicationId: opaque },
        { roomRef: { applicationId: 'app', groupId: opaque } },
        { rallar: { minSnapshotVersion: opaque } }
    ])('rejects malformed selected scope fields %j', (request) => {
        expect(toConnectCommand('command', { request }).left).toBeInstanceOf(Error);
    });

    it.each([
        { action: 'open', name: 'document', initialValue: opaque, transport: 'local-only' },
        { action: 'apply', handle: 'document', batch: { kind: 'batch', operations: [{ kind: 'map.set', path: [], key: 'data', value: opaque }] } },
        { action: 'sync', handle: 'document', reason: 'test', transport: 'rtc-with-ws-fallback' },
        { action: 'wait', handle: 'document', conditions: [{ source: 'value', operator: 'equals', expected: opaque }], sync: false },
        { action: 'undo', handle: 'document', targetOperationGroupId: 'group', operations: [{ kind: 'map.set', path: [], key: 'data', value: opaque }] },
        { action: 'redo', handle: 'document', targetOperationGroupId: 'group', operations: [{ kind: 'map.set', path: [], key: 'data', value: opaque }] },
        { action: 'read', handle: 'document' },
        { action: 'health', handle: 'document' },
        { action: 'close', handle: 'document' },
        { action: 'destroy', handle: 'document' }
    ])('preserves the existing CRDT command family for $action', (request) => {
        const result = toCrdtCommand('command', { request });
        expect(result.left).toBeUndefined();
        const { action, ...fields } = request;
        expect(result.right).toMatchObject({ kind: `crdt.${action}`, commandId: 'command', ...fields });
    });

    it('preserves scalar scope, connection and fallback identity conversions', () => {
        const interaction = {
            request: {
                connection: 42,
                actor: false,
                applicationId: 7,
                workspaceId: false,
                roomId: 9,
                scenarioExecutionNumber: 1,
                interactionExecutionNumber: 2,
                repeatIndex: 0
            }
        };
        expect(toRallarRemoteBrowserCommandId('connect', interaction).right)
            .toBe('rallar-remote-browser-connect-s1-i2-r0-42-false');
        expect(toConnectCommand('command', interaction).right).toMatchObject({
            connection: '42',
            roomRef: { applicationId: '7', workspaceId: 'false', groupId: '9' }
        });
    });

    it('keeps explicit identity independent of unused fallback fields', () => {
        expect(
            toRallarRemoteBrowserCommandId('health', {
                request: { commandId: ' explicit ', scenarioExecutionNumber: opaque }
            }).right
        ).toBe('explicit');
    });

    it('preserves finite RTC timeout and version values accepted by the control protocol', () => {
        expect(toSendCommand('command', { request: { timeoutMs: 1.5, minSnapshotVersion: 2.5 } }).right)
            .toMatchObject({ timeoutMs: 1.5, minSnapshotVersion: 2.5 });
    });

    it('preserves opaque send and CRDT application values', () => {
        expect(toSendCommand('send', { request: { send: { data: opaque } } }).right)
            .toMatchObject({ kind: 'rtc.send', send: { data: opaque } });
        expect(toCrdtCommand('open', { request: { name: 'document', initialValue: opaque } }).right)
            .toMatchObject({ kind: 'crdt.open', initialValue: opaque });
    });

    it.each(
        [
            ['connect', { connection: opaque }],
            ['connect', { timeoutMs: opaque }],
            ['send', { connection: 'room', minSnapshotVersion: opaque }],
            ['close', { actor: opaque }],
            ['command', { action: opaque }],
            ['command', { action: 'read', handle: opaque }]
        ] as const
    )('returns provider failure for invalid %s preparation without HTTP', async (operation, request) => {
        const requests: string[] = [];
        const provider = createRallarRemoteBrowserRtcProvider({
            fetch: async (url) => {
                requests.push(String(url));
                throw new Error('Invalid preparation reached HTTP');
            }
        });
        const interaction = { request, response: {} };
        const config = { interactionName: 'invalidCommand', interaction };
        const context = {
            dependencies: { now: () => 1000 },
            rtcConnections: { room: {} },
            rtcMessages: {},
            rtcDiagnostics: {},
            rtcCloseEvents: {}
        };
        const execute = provider[operation];
        if (!execute) {
            throw new Error('Provider command boundary is unavailable');
        }
        const result = await execute(interaction, config, context);
        expect(result.status).toBe('FAILURE');
        expect(requests).toEqual([]);
    });
    it.each(['http', 'ws-open', 'ws-send', 'ws-close'] as const)('rejects invalid identity at the %s consumer before HTTP', async (operation) => {
        const requests: string[] = [];
        const fetch = async (url: RequestInfo | URL): Promise<Response> => {
            requests.push(String(url));
            throw new Error('Invalid identity reached HTTP');
        };
        const interaction = { request: { action: operation.slice(3), connection: 'room', path: 'https://example.test', repeatIndex: 1 }, response: {} };
        Reflect.set(interaction.request, 'repeatIndex', opaque);
        const config = { interactionName: 'invalidIdentity', interaction };
        const context = {
            dependencies: { now: () => 1000, createUuid: () => 'fixed-id' },
            options: { rallarRemoteBrowser: { fetch } },
            wsConnections: {},
            wsMessages: {},
            wsCloseEvents: {}
        };
        if (operation === 'ws-send') {
            Reflect.set(context.wsConnections, 'room', { remote: true });
        }
        const result = operation === 'http'
            ? await executeRemoteHttpInteraction(interaction, config, context)
            : await executeRemoteWsInteraction(interaction, config, context);
        expect(result.status).toBe('FAILURE');
        expect(requests).toEqual([]);
    });
    it('reports invalid health preparation even when cached diagnostics already match', async () => {
        const provider = createRallarRemoteBrowserRtcProvider({
            fetch: async () => Response.json({ runId: 'remote-browser-run', results: [], events: [] })
        });
        const interaction = { request: { connection: 'room', timeoutMs: opaque }, response: { health: { ready: true }, withinMs: 1 } };
        const result = await provider.wait(interaction, { interaction }, {
            dependencies: { now: () => 1000 },
            rtcConnections: { room: { diagnostics: { ready: true } } },
            rtcMessages: {},
            rtcDiagnostics: {},
            rtcCloseEvents: {}
        });
        expect(result.status).toBe('FAILURE');
        expect(result.actual.exception).toContain('timeoutMs');
    });
});
