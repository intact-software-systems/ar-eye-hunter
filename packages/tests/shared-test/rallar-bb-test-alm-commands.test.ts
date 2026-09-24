import { describe, expect, it } from 'vitest';
import { BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-error-message-prefixes.ts';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import {
    createRallarBlackBoxRtcClient,
    createRallarBlackBoxRtcProvider
} from '../../shared-test/rallar-bb-test/black-box-runner-adapter.ts';
import type { RallarBlackBoxBrowserRallarRuntime } from '../../shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    type RallarBlackBoxTestEvent,
    type RallarBlackBoxTestJsonValue,
    type RallarBlackBoxTestRecord,
    type RallarBlackBoxTestState
} from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { formatJsonSchemaValidationErrors, validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

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
        schemaVersion: 1,
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
    reason: undefined
};

const REJECTED_SEND_DIAGNOSTICS = {
    handleId: 'handle-rejected',
    msgId: 'msg-rejected',
    carrier: 'ws',
    status: 'rejected',
    reason: '$.payload: Payload exceeds 65536 bytes.'
};

const DELIVERY_OBSERVATION = {
    handleId: 'handle-1',
    state: 'acknowledged',
    submitted: true,
    enqueued: true,
    confirmedHopPeerIds: ['bob-session'],
    unconfirmedHopPeerIds: [],
    attempts: 2,
    reason: 'hop evidence retained'
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
        authenticate: async () => ({ authenticated: true }),
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
        waitForRoom: async () => {
            throw new Error('This ALM command test does not exercise room readiness.');
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

    it('rejects the supersedence and unicast fields F1 does not carry', () => {
        for (const field of ['key', 'toPeerId']) {
            const schemaResult = validateJsonSchema(
                RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
                recipeWithCommand(`send-${field}`, {
                    kind: 'messages.send',
                    carrier: 'ws',
                    typeId: 'alm.conformance',
                    payload: { n: 1 },
                    [field]: 'unsupported'
                })
            );
            expect(schemaResult.ok, field).toBe(false);
            if (!schemaResult.ok) {
                expect(formatJsonSchemaValidationErrors(schemaResult.errors)).toContain(field);
            }

            const controlResult = validateRallarBlackBoxTestCommand({
                kind: 'messages.send',
                commandId: `send-${field}`,
                carrier: 'ws',
                typeId: 'alm.conformance',
                payload: { n: 1 },
                [field]: 'unsupported'
            });
            expect(controlResult.ok, field).toBe(false);
            if (!controlResult.ok) {
                expect(controlResult.error).toBe(`messages.send has unsupported field: ${field}.`);
            }
        }
    });

    it('accepts a messages.send replay onto one carrier and refuses an unknown replay carrier', () => {
        const replay = (carrier: string) => ({
            kind: 'messages.send',
            commandId: `send-replay-${carrier}`,
            connection: 'aliceRtc',
            timeoutMs: 1_000,
            replayOnCarrier: { handleId: 'h1', carrier }
        });

        const valid = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipeWithCommand('send-replay-ws', replay('ws')));
        expect(valid.ok, valid.ok ? undefined : formatJsonSchemaValidationErrors(valid.errors)).toBe(true);
        expect(validateRallarBlackBoxTestCommand(replay('ws')).ok).toBe(true);

        const invalid = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipeWithCommand('send-replay-x', replay('x')));
        expect(invalid.ok).toBe(false);
        const refused = validateRallarBlackBoxTestCommand(replay('x'));
        expect(refused.ok).toBe(false);
        if (!refused.ok) {
            expect(refused.error).toBe('messages.send.replayOnCarrier.carrier must be one of ws, rtc.');
        }
        const unnamed = validateRallarBlackBoxTestCommand({ ...replay('ws'), replayOnCarrier: { carrier: 'ws' } });
        expect(unnamed.ok).toBe(false);
    });

    it('refuses every ordinary send field beside a replay, naming each, and still requires them of an ordinary send', () => {
        const replay = {
            kind: 'messages.send',
            commandId: 'send-replay-with-fields',
            carrier: 'rtc',
            typeId: 'alm.conformance',
            payload: { n: 1 },
            ack: 'receiver',
            handleId: 'h2',
            replayOnCarrier: { handleId: 'h1', carrier: 'ws' }
        };

        const refused = validateRallarBlackBoxTestCommand(replay);
        expect(refused.ok).toBe(false);
        if (!refused.ok) {
            expect(refused.messages).toEqual(
                ['carrier', 'typeId', 'payload', 'ack', 'handleId'].map((field) =>
                    `messages.send.${field} is not allowed on a replay; a replay names only connection and replayOnCarrier.`
                )
            );
        }
        const ordinary = validateRallarBlackBoxTestCommand({ kind: 'messages.send', commandId: 'send-bare', connection: 'c' });
        expect(ordinary.ok).toBe(false);
        if (!ordinary.ok) {
            expect(ordinary.messages).toEqual(['carrier', 'typeId', 'payload'].map((field) => `messages.send.${field} is required.`));
        }
        const schemaResult = validateJsonSchema(
            RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
            recipeWithCommand('send-bare', { kind: 'messages.send', connection: 'c' })
        );
        expect(schemaResult.ok).toBe(false);
        if (!schemaResult.ok) {
            expect(formatJsonSchemaValidationErrors(schemaResult.errors)).toContain(
                'messages.send requires carrier, unless it is a replay naming replayOnCarrier.'
            );
        }
    });

    it('accepts a snapshot floor in either form and refuses a floor naming both, neither, or a non-positive integer', () => {
        const send = (minSnapshotVersion: RallarBlackBoxTestJsonValue) => ({
            kind: 'messages.send',
            commandId: 'send-floor',
            carrier: 'rtc',
            typeId: 'alm.conformance',
            payload: { n: 1 },
            minSnapshotVersion
        });
        for (const floor of [{ absolute: 999_999 }, { aboveCurrentBy: 1 }]) {
            const schemaResult = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipeWithCommand('send-floor', send(floor)));
            expect(schemaResult.ok, schemaResult.ok ? undefined : formatJsonSchemaValidationErrors(schemaResult.errors)).toBe(true);
            expect(validateRallarBlackBoxTestCommand(send(floor)).ok).toBe(true);
        }
        const path = 'messages.send.minSnapshotVersion';
        for (
            const [floor, message] of [
                [{ absolute: 1, aboveCurrentBy: 1 }, `${path} must name exactly one of absolute, aboveCurrentBy.`],
                [{}, `${path} must name exactly one of absolute, aboveCurrentBy.`],
                [{ absolute: 0 }, `${path}.absolute must be >= 1.`],
                [{ aboveCurrentBy: 1.5 }, `${path}.aboveCurrentBy must be an integer.`],
                [{ below: 1 }, `${path} has unsupported field: below.`],
                [3, `${path} must be an object.`]
            ] as const
        ) {
            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipeWithCommand('send-floor', send(floor))).ok, JSON.stringify(floor))
                .toBe(false);
            const refused = validateRallarBlackBoxTestCommand(send(floor));
            expect(refused.ok, JSON.stringify(floor)).toBe(false);
            if (!refused.ok) {
                expect(refused.messages).toContain(message);
            }
        }
    });

    it('refuses a snapshot floor on a replay', () => {
        const refused = validateRallarBlackBoxTestCommand({
            kind: 'messages.send',
            commandId: 'send-replay-with-floor',
            minSnapshotVersion: { aboveCurrentBy: 1 },
            replayOnCarrier: { handleId: 'h1', carrier: 'ws' }
        });
        expect(refused.ok).toBe(false);
        if (!refused.ok) {
            expect(refused.messages).toEqual([
                'messages.send.minSnapshotVersion is not allowed on a replay; a replay names only connection and replayOnCarrier.'
            ]);
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
            enqueued: true,
            confirmedHopPeerIds: ['bob-session'],
            unconfirmedHopPeerIds: [],
            attempts: 2,
            reason: 'hop evidence retained'
        });
        expect(topicsOf(runtime.state())).toEqual(
            expect.arrayContaining(['rallar.bb.messages.sent', 'rallar.bb.messages.observed'])
        );
    });

    it('reads a replay send as the replayed handle and its carrier verdict, and refuses an unknown verdict', async () => {
        const replayed = { handleId: 'handle-1', msgId: 'msg-1', carrier: 'ws', verdict: 'admitted' };
        const captures = createAlmRuntimeCaptures();
        const replayCommand = {
            kind: 'messages.send',
            commandId: 'alm-replay',
            connection: 'aliceRtc',
            replayOnCarrier: { handleId: 'handle-1', carrier: 'ws' }
        } as const;
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createAlmBrowserRuntimeFake(captures),
                sendMessage: async (input) => {
                    captures.sendMessage.push(decodeCapturedInput(input));
                    return replayed;
                }
            }
        });

        const result = await runtime.execute(replayCommand);

        expect(result.ok, result.error?.message).toBe(true);
        expect(result.value).toEqual(replayed);
        expect(captures.sendMessage[0]).toMatchObject({ replayOnCarrier: { handleId: 'handle-1', carrier: 'ws' } });
        expect(captures.sendMessage[0]).not.toHaveProperty('handleId');

        const refusing = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createAlmBrowserRuntimeFake(createAlmRuntimeCaptures()),
                sendMessage: async () => ({ ...replayed, verdict: 'delivered' })
            }
        });
        const refused = await refusing.execute({ ...replayCommand, commandId: 'alm-replay-unknown-verdict' });
        expect(refused.error).toMatchObject({
            code: 'RALLAR_BLACK_BOX_ALM_INVALID_RUNTIME_RESULT',
            message: 'The page runtime returned no usable messages.send replay result.verdict.'
        });
    });

    it('carries a rejected send through as a successful command value with its envelope msgId', async () => {
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
            msgId: 'msg-rejected',
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

    it('fails a command whose page-runtime result is missing a field instead of defaulting it', async () => {
        const captures = createAlmRuntimeCaptures();
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createAlmBrowserRuntimeFake(captures),
                readStorageCounters: async () => ({ total: 4, byOwner: { 'al-admission': 4 }, byKind: {} })
            }
        });

        const result = await runtime.execute({
            kind: 'storage.counters',
            commandId: 'alm-counters-malformed',
            reset: false
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BLACK_BOX_ALM_INVALID_RUNTIME_RESULT',
            message: 'The page runtime returned no usable storage.counters result.byOwner.al-work.'
        });
    });

    it('fails a send whose page-runtime result names an unknown carrier', async () => {
        const captures = createAlmRuntimeCaptures();
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createAlmBrowserRuntimeFake(captures),
                sendMessage: async () => ({ ...SEND_DIAGNOSTICS, carrier: 'quic' })
            }
        });

        const result = await runtime.execute({
            kind: 'messages.send',
            commandId: 'alm-send-unknown-carrier',
            connection: 'aliceRtc',
            carrier: 'ws',
            typeId: 'alm.conformance',
            payload: { n: 1 },
            handleId: 'handle-1'
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BLACK_BOX_ALM_INVALID_RUNTIME_RESULT',
            message: 'The page runtime returned no usable messages.send result.carrier.'
        });
    });

    it('classifies the page runtime rejections by their exported message prefixes', async () => {
        const cases = [
            {
                commandId: 'alm-receipts-timeout',
                message: `${BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.deliveryStateTimeout} h-1 did not reach [acknowledged]; last state accepted`,
                code: 'RALLAR_BLACK_BOX_ALM_DELIVERY_STATE_TIMEOUT'
            },
            {
                commandId: 'alm-receipts-no-ports',
                message:
                    `${BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.scriptedPortsUnavailable}: storage.counters needs a connection that names an application.`,
                code: 'RALLAR_BLACK_BOX_ALM_SCRIPTED_PORTS_UNAVAILABLE'
            },
            {
                commandId: 'alm-receipts-replay-unavailable',
                message: `${BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.replayUnavailable}: no connected session.`,
                code: 'RALLAR_BLACK_BOX_ALM_REPLAY_UNAVAILABLE'
            },
            {
                commandId: 'alm-receipts-bad-input',
                message: 'delivery handle handleId is required.',
                code: 'RALLAR_BLACK_BOX_ALM_INVALID_COMMAND_INPUT'
            }
        ];

        for (const testCase of cases) {
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    ...createAlmBrowserRuntimeFake(createAlmRuntimeCaptures()),
                    readReceipts: () => Promise.reject(new TypeError(testCase.message))
                }
            });

            const result = await runtime.execute({
                kind: 'messages.receipts',
                commandId: testCase.commandId,
                handleId: 'h-1'
            });

            expect(result.ok, testCase.commandId).toBe(false);
            expect(result.error).toMatchObject({ code: testCase.code, message: testCase.message });
        }
    });
});

async function runAlmKindThroughRtcSendStep(kind: string) {
    const provider = createRallarBlackBoxRtcProvider(createRallarBlackBoxTestRuntime(), { commandIdPrefix: 'rallar-bb' });
    return await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar-bb',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        kind,
                        connection: 'aliceRtc',
                        provider: 'rallar-bb',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: { n: 1 },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSendsBrowserOnlyKind: {}
            }
        ],
        0,
        { rtcProviders: { 'rallar-bb': provider } }
    );
}

describe('ALM commands on the in-process runner adapter', () => {
    it('fails the runner step for a browser-only ALM kind instead of reporting a pass', async () => {
        const report = await runAlmKindThroughRtcSendStep('messages.send');
        const step = report.resultsByName.aliceSendsBrowserOnlyKind[0];

        expect(report.summary.failure).toBe(1);
        expect(step.status).toBe('FAILURE');
        expect(step.result).toBe('messages.send requires a browser agent');
        expect(step.actual.code).toBe('browser-only-command');
    });

    it('rejects every browser-only ALM kind instead of translating it to an RTC send', async () => {
        const client = createRallarBlackBoxRtcClient(
            createRallarBlackBoxTestRuntime(),
            { connection: 'alice' },
            { commandIdPrefix: 'rallar-bb' }
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

it.each(['submitted', 'pending-authority', 'unobservable'])('accepts %s in recipe delivery observations', (state) => {
    const recipe = recipeWithCommand('lifecycle', { kind: 'messages.observe', connection: 'alice', handleId: 'h-1', state: [state] });
    expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe).ok).toBe(true);
    expect(validateRallarBlackBoxTestCommand(recipe.commands[0]).ok).toBe(true);
});
