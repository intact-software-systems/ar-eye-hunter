import { describe, expect, it } from 'vitest';
import { createRallarBlackBoxRtcClient } from '../../shared-test/rallar-bb-test/black-box-runner-adapter.ts';
import {
    createRallarBlackBoxBrowserTestRuntime,
    type RallarBlackBoxBrowserRallarRuntime
} from '../../shared-test/rallar-bb-test/browser-adapter.ts';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime.ts';
import {
    formatJsonSchemaValidationErrors,
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    validateJsonSchema
} from '../../shared-test/rallar-bb-test/schema.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    type RallarBlackBoxTestEvent,
    type RallarBlackBoxTestRecord,
    type RallarBlackBoxTestState
} from '../../shared-test/rallar-bb-test/types.ts';

const ALM_COMMAND_KINDS = [
    'messages.send',
    'messages.observe',
    'messages.cancel',
    'messages.received',
    'messages.receipts',
    'fault.inject',
    'storage.counters',
    'agent.reload'
] as const;

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function recipeWithCommand(commandId: string, command: RallarBlackBoxTestRecord) {
    return {
        recipeId: 'alm-send',
        name: 'alm send',
        commands: [{ commandId, timeoutMs: 5_000, ...command }]
    };
}

interface AlmRuntimeCaptures {
    readonly sendMessage: RallarBlackBoxTestRecord[];
    readonly observeDelivery: RallarBlackBoxTestRecord[];
    readonly cancelDelivery: RallarBlackBoxTestRecord[];
    readonly readReceipts: RallarBlackBoxTestRecord[];
    readonly injectFault: RallarBlackBoxTestRecord[];
    readonly readStorageCounters: RallarBlackBoxTestRecord[];
}

const SEND_DIAGNOSTICS = {
    handleId: 'handle-1',
    msgId: 'msg-1',
    carrier: 'ws',
    status: 'accepted',
    reason: undefined,
    message: { id: { msgId: 'msg-1' } }
};

const REJECTED_SEND_DIAGNOSTICS = {
    handleId: 'handle-rejected',
    msgId: undefined,
    carrier: 'ws',
    status: 'rejected',
    reason: '$.payload: Payload exceeds 65536 bytes.',
    message: undefined
};

const DELIVERY_OBSERVATION = {
    handleId: 'handle-1',
    state: 'acknowledged',
    submitted: true,
    confirmedPeerIds: ['bob-session'],
    unconfirmedPeerIds: [],
    attempts: 2
};

const STORAGE_COUNTS = {
    total: 7,
    byOwner: { 'al-admission': 3, 'al-work': 4 },
    byKind: { read: 3, 'work-write': 4 }
};

function decodeCapturedInput(value: unknown): RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null ? value as RallarBlackBoxTestRecord : {};
}

function createAlmRuntimeCaptures(): AlmRuntimeCaptures {
    return {
        sendMessage: [],
        observeDelivery: [],
        cancelDelivery: [],
        readReceipts: [],
        injectFault: [],
        readStorageCounters: []
    };
}

function createAlmBrowserRuntimeFake(
    captures: AlmRuntimeCaptures
): RallarBlackBoxBrowserRallarRuntime {
    return {
        connect: async () => ({ connected: true }),
        send: async () => ({ sent: true }),
        sendMessage: async (input) => {
            captures.sendMessage.push(decodeCapturedInput(input));
            return SEND_DIAGNOSTICS;
        },
        observeDelivery: async (input) => {
            captures.observeDelivery.push(decodeCapturedInput(input));
            return DELIVERY_OBSERVATION;
        },
        cancelDelivery: async (input) => {
            captures.cancelDelivery.push(decodeCapturedInput(input));
            return { ...DELIVERY_OBSERVATION, state: 'cancelled' };
        },
        readReceipts: async (input) => {
            captures.readReceipts.push(decodeCapturedInput(input));
            return DELIVERY_OBSERVATION;
        },
        injectFault: async (input) => {
            captures.injectFault.push(decodeCapturedInput(input));
            return undefined;
        },
        readStorageCounters: async (input) => {
            captures.readStorageCounters.push(decodeCapturedInput(input));
            return STORAGE_COUNTS;
        },
        refreshRoom: async () => undefined,
        close: async () => ({ closed: true }),
        health: async () => ({ connected: true })
    };
}

function topicsOf(state: RallarBlackBoxTestState): readonly string[] {
    return state.events.map((event: RallarBlackBoxTestEvent) => event.topic);
}

function inboundMessageEvent(msgId: string) {
    return {
        kind: 'message',
        topic: 'rallar.browser.ws.message',
        connection: 'aliceRtc',
        transport: 'ws',
        typeId: 'alm.conformance',
        data: {
            msgId,
            typeId: 'alm.conformance',
            topicId: 'alm.topic',
            transport: 'ws',
            payload: { n: 1 }
        }
    } as const;
}

describe('ALM recipe commands', () => {
    it('registers every ALM command kind', () => {
        for (const kind of ALM_COMMAND_KINDS) {
            expect(RALLAR_BLACK_BOX_TEST_COMMAND_KINDS).toContain(kind);
        }
    });

    it('accepts a valid messages.send and rejects a send without a carrier', () => {
        const valid = validateJsonSchema(
            RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
            recipeWithCommand('send-1', {
                kind: 'messages.send',
                carrier: 'ws',
                typeId: 'alm.conformance',
                payload: { n: 1 },
                handleId: 'h-1'
            })
        );
        expect(valid.ok, valid.ok ? undefined : formatJsonSchemaValidationErrors(valid.errors)).toBe(true);

        const invalid = validateJsonSchema(
            RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
            recipeWithCommand('send-2', {
                kind: 'messages.send',
                typeId: 'x',
                payload: {}
            })
        );
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
            expect(formatJsonSchemaValidationErrors(invalid.errors)).toContain('carrier');
        }
    });

    it('rejects a control-protocol messages.send without a carrier', () => {
        const result = validateRallarBlackBoxTestCommand({
            kind: 'messages.send',
            commandId: 'send-3',
            typeId: 'x',
            payload: {}
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('carrier');
        }
    });
});

describe('ALM browser adapter execution', () => {
    it('sends a typed message and observes its delivery through the page runtime', async () => {
        const captures = createAlmRuntimeCaptures();
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: createAlmBrowserRuntimeFake(captures)
        });
        await runtime.execute({
            kind: 'configure',
            commandId: 'alm-configure',
            config: { defaults: { connection: 'aliceRtc' } }
        });

        const sent = await runtime.execute({
            kind: 'messages.send',
            commandId: 'alm-send',
            carrier: 'ws',
            typeId: 'alm.conformance',
            payload: { n: 1 },
            handleId: 'handle-1'
        });
        const observed = await runtime.execute({
            kind: 'messages.observe',
            commandId: 'alm-observe',
            handleId: 'handle-1',
            state: ['acknowledged'],
            timeoutMs: 2_500
        });

        expect(sent.ok, sent.error?.message).toBe(true);
        expect(sent.value).toEqual({
            handleId: 'handle-1',
            msgId: 'msg-1',
            carrier: 'ws',
            status: 'accepted'
        });
        expect(observed.ok, observed.error?.message).toBe(true);
        expect(observed.value).toEqual({
            handleId: 'handle-1',
            state: 'acknowledged',
            submitted: true,
            confirmedPeerIds: ['bob-session'],
            unconfirmedPeerIds: [],
            attempts: 2
        });
        expect(topicsOf(runtime.state())).toEqual(
            expect.arrayContaining(['rallar.bb.messages.sent', 'rallar.bb.messages.observed'])
        );
    });

    it('carries a rejected send through as a successful command value without a msgId', async () => {
        const captures = createAlmRuntimeCaptures();
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createAlmBrowserRuntimeFake(captures),
                sendMessage: async (input) => {
                    captures.sendMessage.push(decodeCapturedInput(input));
                    return REJECTED_SEND_DIAGNOSTICS;
                }
            }
        });
        await runtime.execute({
            kind: 'configure',
            commandId: 'alm-configure-rejected',
            config: { defaults: { connection: 'aliceRtc' } }
        });

        const sent = await runtime.execute({
            kind: 'messages.send',
            commandId: 'alm-send-rejected',
            carrier: 'ws',
            typeId: 'alm.conformance',
            payload: { oversized: true },
            handleId: 'handle-rejected'
        });

        expect(sent.ok, sent.error?.message).toBe(true);
        expect(sent.value).toEqual({
            handleId: 'handle-rejected',
            carrier: 'ws',
            status: 'rejected',
            reason: '$.payload: Payload exceeds 65536 bytes.'
        });
        expect(topicsOf(runtime.state())).toContain('rallar.bb.messages.sent');
    });

    it('injects the connection, handle, and observe timeout the page runtime requires', async () => {
        const captures = createAlmRuntimeCaptures();
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: createAlmBrowserRuntimeFake(captures)
        });
        await runtime.execute({
            kind: 'configure',
            commandId: 'alm-configure-defaults',
            config: { defaults: { connection: 'aliceRtc' } }
        });

        await runtime.execute({
            kind: 'messages.send',
            commandId: 'alm-send-defaults',
            carrier: 'rtc',
            typeId: 'alm.conformance',
            payload: { n: 2 }
        });
        await runtime.execute({
            kind: 'messages.observe',
            commandId: 'alm-observe-defaults',
            handleId: 'alm-send-defaults',
            state: ['acknowledged'],
            timeoutMs: 1_500
        });

        expect(captures.sendMessage[0]).toMatchObject({
            connection: 'aliceRtc',
            handleId: 'alm-send-defaults',
            carrier: 'rtc',
            typeId: 'alm.conformance'
        });
        expect(captures.observeDelivery[0]).toMatchObject({
            connection: 'aliceRtc',
            handleId: 'alm-send-defaults',
            state: ['acknowledged'],
            timeoutMs: 1_500
        });
    });

    it('counts inbound typed messages and fails when the window closes short', async () => {
        const captures = createAlmRuntimeCaptures();
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: createAlmBrowserRuntimeFake(captures)
        });
        await runtime.execute({
            kind: 'configure',
            commandId: 'alm-configure-received',
            config: { defaults: { connection: 'aliceRtc' } }
        });
        runtime.receiveRallarBrowserEvent(inboundMessageEvent('msg-1'));

        const matched = await runtime.execute({
            kind: 'messages.received',
            commandId: 'alm-received-matched',
            typeId: 'alm.conformance',
            msgId: 'msg-1',
            count: 1,
            windowMs: 40
        });
        const short = await runtime.execute({
            kind: 'messages.received',
            commandId: 'alm-received-short',
            typeId: 'alm.conformance',
            count: 2,
            windowMs: 40
        });

        expect(matched.ok, matched.error?.message).toBe(true);
        expect(matched.value).toEqual({
            typeId: 'alm.conformance',
            msgId: 'msg-1',
            count: 1,
            observed: 1,
            absent: false
        });
        expect(short.ok).toBe(false);
        expect(short.value).toMatchObject({ count: 2, observed: 1, absent: false });
        expect(topicsOf(runtime.state())).toContain('rallar.bb.messages.received');
    });

    it('aborts a messages.received poll promptly when the recipe is cancelled', async () => {
        const captures = createAlmRuntimeCaptures();
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: createAlmBrowserRuntimeFake(captures)
        });

        const startedAt = Date.now();
        const pending = runtime.execute({
            kind: 'messages.received',
            commandId: 'alm-received-cancelled',
            typeId: 'alm.conformance',
            count: 1,
            windowMs: 60_000
        });
        await sleepMs(20);
        await runtime.execute({
            kind: 'recipe.cancel',
            commandId: 'cancel-received',
            reason: 'operator requested stop'
        });
        const result = await pending;

        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BLACK_BOX_ALM_COMMAND_ABORTED',
            message: 'operator requested stop'
        });
    });

    it('holds the absence window and fails when a matching message arrived', async () => {
        const captures = createAlmRuntimeCaptures();
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: createAlmBrowserRuntimeFake(captures)
        });
        runtime.receiveRallarBrowserEvent(inboundMessageEvent('msg-9'));

        const violated = await runtime.execute({
            kind: 'messages.received',
            commandId: 'alm-received-absent',
            connection: 'aliceRtc',
            typeId: 'alm.conformance',
            count: 1,
            absent: true,
            windowMs: 20
        });
        const clean = await runtime.execute({
            kind: 'messages.received',
            commandId: 'alm-received-absent-clean',
            connection: 'aliceRtc',
            typeId: 'alm.other',
            count: 1,
            absent: true,
            windowMs: 20
        });

        expect(violated.ok).toBe(false);
        expect(violated.value).toMatchObject({ observed: 1, absent: true });
        expect(clean.ok, clean.error?.message).toBe(true);
        expect(clean.value).toMatchObject({ observed: 0, absent: true });
    });

    it('injects faults, reads storage counters, and records the agent reload request', async () => {
        const captures = createAlmRuntimeCaptures();
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: createAlmBrowserRuntimeFake(captures)
        });

        const injected = await runtime.execute({
            kind: 'fault.inject',
            commandId: 'alm-fault',
            faultId: 'drop-first-ack',
            carrier: 'ws',
            match: { controlType: 'ack', typeId: 'alm.conformance' },
            action: 'drop',
            remaining: 1
        });
        const counters = await runtime.execute({
            kind: 'storage.counters',
            commandId: 'alm-counters',
            reset: true
        });
        const reload = await runtime.execute({
            kind: 'agent.reload',
            commandId: 'alm-reload',
            readyTimeoutMs: 30_000
        });

        expect(injected.ok, injected.error?.message).toBe(true);
        expect(injected.value).toEqual({ faultId: 'drop-first-ack', injected: true });
        expect(captures.injectFault[0]).toMatchObject({
            faultId: 'drop-first-ack',
            carrier: 'ws',
            remaining: 1
        });
        expect(counters.ok, counters.error?.message).toBe(true);
        expect(counters.value).toEqual({
            total: 7,
            byOwner: { 'al-admission': 3, 'al-work': 4 },
            byKind: { read: 3, 'work-write': 4 }
        });
        expect(captures.readStorageCounters[0]).toMatchObject({ reset: true });
        expect(reload.ok, reload.error?.message).toBe(true);
        expect(reload.value).toEqual({ requested: true, readyTimeoutMs: 30_000 });
        expect(topicsOf(runtime.state())).toEqual(
            expect.arrayContaining([
                'rallar.bb.fault.injected',
                'rallar.bb.storage.counters',
                'rallar.bb.agent.reload_requested'
            ])
        );
    });

    it('cancels a delivery and reads its receipts through the page runtime', async () => {
        const captures = createAlmRuntimeCaptures();
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: createAlmBrowserRuntimeFake(captures)
        });

        const receipts = await runtime.execute({
            kind: 'messages.receipts',
            commandId: 'alm-receipts',
            handleId: 'handle-1'
        });
        const cancelled = await runtime.execute({
            kind: 'messages.cancel',
            commandId: 'alm-cancel',
            handleId: 'handle-1'
        });

        expect(receipts.ok, receipts.error?.message).toBe(true);
        expect(receipts.value).toMatchObject({ handleId: 'handle-1', state: 'acknowledged' });
        expect(cancelled.ok, cancelled.error?.message).toBe(true);
        expect(cancelled.value).toMatchObject({ handleId: 'handle-1', state: 'cancelled' });
        expect(captures.readReceipts[0]).toMatchObject({ connection: 'default', handleId: 'handle-1' });
        expect(topicsOf(runtime.state())).toEqual(
            expect.arrayContaining(['rallar.bb.messages.receipts', 'rallar.bb.messages.cancelled'])
        );
    });

    it('fails an ALM command with a typed error when the page runtime rejects it', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createAlmBrowserRuntimeFake(createAlmRuntimeCaptures()),
                readReceipts: () => Promise.reject(new TypeError('Unknown delivery handle handle-x'))
            }
        });

        const result = await runtime.execute({
            kind: 'messages.receipts',
            commandId: 'alm-receipts-unknown',
            handleId: 'handle-x'
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BLACK_BOX_ALM_UNKNOWN_DELIVERY_HANDLE',
            message: 'Unknown delivery handle handle-x'
        });
    });
});

describe('ALM commands on the in-process runner adapter', () => {
    it('rejects every browser-only ALM kind instead of translating it to an RTC send', async () => {
        const client = createRallarBlackBoxRtcClient(
            createRallarBlackBoxTestRuntime(),
            { connection: 'alice' }
        );

        for (const kind of ALM_COMMAND_KINDS) {
            const outcome = await client.send({ n: 1 }, {
                request: { kind, connection: 'alice' }
            });

            expect(outcome).toEqual({
                status: 'failed',
                error: {
                    code: 'browser-only-command',
                    message: `${kind} requires a browser agent`
                }
            });
        }
    });
});
