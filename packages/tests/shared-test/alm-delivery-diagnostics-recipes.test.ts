import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type {
    RallarBlackBoxBrowserRallarConnectionConfig,
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserTestRuntime
} from '@shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { toRallarConnectionConfig } from '@shared-test/rallar-bb-test/browser/browser-rallar-command-input.ts';
import * as AlmRecipes from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecord } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { snapshotExecutableRecipe } from '@shared-test/rallar-bb-test/recipe/snapshot-executable-recipe.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { toMergedRuntimeConfig } from '@shared-test/rallar-bb-test/runtime/to-merged-runtime-config.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { createHetznerDistributedManifestCatalog } from '../../../apps/rallar-black-box/src/create-hetzner-distributed-manifest-catalog.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const ALM_TOPICS = [
    'rallar.browser.alm.outbound_diagnostics',
    'rallar.browser.alm.inbound_diagnostics',
    'rallar.browser.alm.storage',
    'rallar.browser.alm.storage_reset'
];

afterEach(() => vi.useRealTimers());

describe('ALM delivery diagnostic selection', () => {
    it.each([true, false])('executes an independent pair with recording %s', async (almDiagnostics) => {
        vi.useFakeTimers();
        const scenario = AlmRecipes.createAlmDeliveryDiagnosticsRecipes(toConformanceInput('ws'), almDiagnostics);
        const lane = new DeliveryLane();
        const receiver = await lane.createAgent('receiver');
        const sender = await lane.createAgent('sender');
        const execution = Promise.all([
            receiver.execute({ kind: 'recipe.run', recipe: scenario.receiver }),
            sender.execute({ kind: 'recipe.run', recipe: scenario.sender })
        ]);
        await vi.runAllTimersAsync();
        const results = await execution;

        expect(results.map((result) => result.ok), JSON.stringify(results)).toEqual([true, true]);
        expect(lane.delivered).toEqual([{ payload: { marker: 'delivery-baseline' } }]);
        const senderState = sender.state();
        const receipt = senderState.commandHistory.find((result) => result.kind === 'messages.receipts');
        expect(receipt?.value).toMatchObject({
            state: 'acknowledged',
            receiptMode: 'receiver',
            confirmedRecipientPeerIds: ['receiver-session'],
            unconfirmedRecipientPeerIds: []
        });
        expect(senderState.failures).toEqual([]);
        const published = [sender, receiver].flatMap((agent) => agent.state().events)
            .filter((event) => ALM_TOPICS.includes(event.topic)).map((event) => event.topic);
        expect([...published].sort()).toEqual(almDiagnostics ? [...ALM_TOPICS].sort() : []);
    });

    it.each([
        { failure: 'wrong-payload', command: 'receiver-received-payload' },
        { failure: 'bad-receipt', command: 'sender-assert-receipt-confirmedRecipientPeerIds-count-1' },
        { failure: 'missing-policy', command: 'sender-applied-diagnostics' },
        { failure: 'wrong-policy', command: 'sender-applied-diagnostics' },
        { failure: 'duplicate', command: 'receiver-received-2' }
    ])('rejects observable $failure failure', async ({ failure, command }) => {
        vi.useFakeTimers();
        const scenario = AlmRecipes.createAlmDeliveryDiagnosticsRecipes(toConformanceInput('ws'), false);
        const lane = new DeliveryLane(failure);
        const receiver = await lane.createAgent('receiver');
        const sender = await lane.createAgent('sender');
        const execution = Promise.all([
            receiver.execute({ kind: 'recipe.run', recipe: scenario.receiver }),
            sender.execute({ kind: 'recipe.run', recipe: scenario.sender })
        ]);
        await vi.runAllTimersAsync();
        const results = await execution;
        expect(results.some((result) => !result.ok)).toBe(true);
        expect([sender, receiver].flatMap((agent) => agent.state().failures).some((result) => result.commandId.endsWith(command))).toBe(true);
    });

    it.each(ALM_TOPICS)('rejects suppressed diagnostic publication on %s', async (topic) => {
        vi.useFakeTimers();
        const pair = AlmRecipes.createAlmDeliveryDiagnosticsRecipes(toConformanceInput('ws'), false);
        const lane = new DeliveryLane(topic);
        const receiver = await lane.createAgent('receiver');
        const sender = await lane.createAgent('sender');
        const execution = Promise.all([
            receiver.execute({ kind: 'recipe.run', recipe: pair.receiver }),
            sender.execute({ kind: 'recipe.run', recipe: pair.sender })
        ]);
        await vi.runAllTimersAsync();
        expect((await execution).every((result) => !result.ok)).toBe(true);
        expect(sender.state().failures[0]?.commandId).toBe(`alm-ws-delivery-diagnostics-off-sender-diagnostic-${topic.split('.').at(-1)}`);
    });

    it('refuses a retained earlier diagnostic interval before connecting', async () => {
        vi.useFakeTimers();
        const pair = AlmRecipes.createAlmDeliveryDiagnosticsRecipes(toConformanceInput('ws'), false);
        const lane = new DeliveryLane();
        const sender = await lane.createAgent('sender');
        sender.receiveRallarBrowserEvent({ kind: 'diagnostic', topic: 'rallar.browser.alm.storage', data: {} });
        const execution = sender.execute({ kind: 'recipe.run', recipe: pair.sender });
        await vi.runAllTimersAsync();
        expect((await execution).ok).toBe(false);
        expect(sender.state().failures[0]?.commandId).toBe('alm-ws-delivery-diagnostics-off-sender-fresh-storage');
        expect(lane.delivered).toEqual([]);
    });

    it('requires expected publication for On after successful delivery', async () => {
        vi.useFakeTimers();
        const pair = AlmRecipes.createAlmDeliveryDiagnosticsRecipes(toConformanceInput('ws'), true);
        const lane = new DeliveryLane('missing-diagnostics');
        const receiver = await lane.createAgent('receiver');
        const sender = await lane.createAgent('sender');
        const execution = Promise.all([
            receiver.execute({ kind: 'recipe.run', recipe: pair.receiver }),
            sender.execute({ kind: 'recipe.run', recipe: pair.sender })
        ]);
        await vi.runAllTimersAsync();
        expect((await execution).map((result) => result.ok)).toEqual([false, false]);
        expect(sender.state().failures[0]?.commandId).toBe('alm-ws-delivery-diagnostics-on-sender-diagnostic-outbound_diagnostics');
        expect(receiver.state().failures[0]?.commandId).toBe('alm-ws-delivery-diagnostics-on-receiver-diagnostic-inbound_diagnostics');
        expect(lane.delivered).toEqual([{ payload: { marker: 'delivery-baseline' } }]);
    });

    it('owns submitted configure and connect booleans independently of later author mutation', () => {
        const configuredRallar = { almDiagnostics: false };
        const connectRallar = { almDiagnostics: true };
        const captured = snapshotExecutableRecipe({
            schemaVersion: 1,
            recipeId: 'owned-policy',
            name: 'Owned policy',
            commands: [
                { kind: 'configure', config: { rallar: configuredRallar } },
                { kind: 'rtc.connect', rallar: connectRallar }
            ]
        });
        configuredRallar.almDiagnostics = true;
        connectRallar.almDiagnostics = false;
        const [configure, connect] = captured.commands;
        expect(configure.kind === 'configure' && configure.config.rallar?.almDiagnostics).toBe(false);
        expect(connect.kind === 'rtc.connect' && connect.rallar?.almDiagnostics).toBe(true);
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, JSON.parse(JSON.stringify(captured))).ok).toBe(true);
    });

    it('preserves independent identities and selection through snapshots and JSON', () => {
        const on = AlmRecipes.createAlmDeliveryDiagnosticsRecipes(toConformanceInput('rtc'), true);
        const off = AlmRecipes.createAlmDeliveryDiagnosticsRecipes(toConformanceInput('rtc'), false);
        expect([on.scenarioKey, off.scenarioKey]).toEqual(['delivery-diagnostics-on', 'delivery-diagnostics-off']);
        const sendIdentities = [on, off].map((pair) =>
            pair.sender.commands.flatMap((command) => command.kind === 'messages.send' && 'typeId' in command ? [command.typeId, command.handleId] : [])
        );
        expect(sendIdentities.every((identities) => identities.length === 2 && identities.every((identity) => typeof identity === 'string'))).toBe(true);
        expect(sendIdentities[0].some((identity) => sendIdentities[1].includes(identity))).toBe(false);
        const ids = [on, off].flatMap((pair) => [pair.sender, pair.receiver]).flatMap((recipe) => {
            expect(recipe.name).toContain('ALM delivery diagnostics');
            expect(recipe.metadata).toMatchObject({
                profile: 'alm-delivery-diagnostics',
                almDiagnostics: recipe === on.sender || recipe === on.receiver,
                freshRuntimeRequired: true
            });
            const snapshot = snapshotExecutableRecipe(recipe);
            const roundTrip = JSON.parse(JSON.stringify(snapshot));
            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, roundTrip).ok).toBe(true);
            expect(roundTrip).toEqual(JSON.parse(JSON.stringify(recipe)));
            const connect = snapshot.commands.find((command) => command.kind === 'rtc.connect');
            expect(connect?.kind === 'rtc.connect' && connect.rallar?.almDiagnostics).toBe(recipe === on.sender || recipe === on.receiver);
            return [recipe.recipeId, ...recipe.commands.map((command) => command.commandId)];
        });
        expect(new Set(ids).size).toBe(ids.length);
    });

    it.each([{ value: 'false' }, { value: 0 }, { value: null }, { value: {} }, { value: [] }])(
        'rejects invalid JSON selection $value',
        ({ value: almDiagnostics }) => {
            for (
                const command of [
                    { kind: 'configure', config: { rallar: { almDiagnostics } } },
                    { kind: 'rtc.connect', rallar: { almDiagnostics } }
                ]
            ) {
                expect(
                    validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, {
                        schemaVersion: 1,
                        recipeId: 'policy',
                        name: 'Policy',
                        commands: [command]
                    }).ok
                ).toBe(false);
            }
        }
    );

    it('inherits configure selection and lets an explicit connect override it without sticky replacement', () => {
        const config = toMergedRuntimeConfig(undefined, { rallar: { almDiagnostics: false } });
        expect(toRallarConnectionConfig({ kind: 'rtc.connect', commandId: 'inherited' }, config).rallar.almDiagnostics).toBe(false);
        expect(toRallarConnectionConfig({ kind: 'rtc.connect', commandId: 'override', rallar: { almDiagnostics: true } }, config).rallar.almDiagnostics).toBe(
            true
        );
        expect(toMergedRuntimeConfig(config, { rallar: { typeId: 'next' } }).rallar?.almDiagnostics).toBeUndefined();
    });

    it('keeps the executable ALM manifests explicitly On through their generator', () => {
        const entries = createHetznerDistributedManifestCatalog().filter((entry) => /\/(18|19|20|21|22)-alm-/.test(entry.filePath));
        expect(entries).toHaveLength(5);
        for (const entry of entries) {
            for (const recipe of entry.manifest.recipes) {
                if (recipe.recipe === undefined) {
                    throw new Error(`Expected executable recipe: ${entry.filePath}`);
                }
                const connects = toNestedCommands(recipe.recipe.commands).filter((command) => command.kind === 'rtc.connect');
                expect(connects.length).toBeGreaterThan(0);
                for (const connect of connects) {
                    expect(connect.kind === 'rtc.connect' && connect.rallar?.almDiagnostics, entry.filePath).toBe(true);
                }
            }
        }
    });

    it.each([
        { carrier: 'rtc', marker: 'wrong', status: 'failed' },
        { carrier: 'rtc', marker: 'delivery-baseline', status: 'ok' },
        { carrier: 'rtc-with-ws-fallback', marker: 'wrong', status: 'failed' },
        { carrier: 'rtc-with-ws-fallback', marker: 'delivery-baseline', status: 'ok' }
    ])('requires the current $carrier payload with retained earlier WS history: $marker', async ({ carrier, marker, status }) => {
        vi.useFakeTimers();
        const manifest = createHetznerDistributedManifestCatalog().find((entry) => entry.filePath.endsWith('/18-alm-conformance-2-agent.json'))?.manifest;
        const receiver = manifest?.recipes.find((selection) => selection.role === 'receiver')?.recipe;
        const payloadWait = receiver?.commands.find((command) => command.commandId === `alm-${carrier}-delivery-baseline-receiver-received-payload`);
        if (payloadWait?.kind !== 'wait') {
            throw new Error('Expected generated current-carrier baseline payload wait.');
        }
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        runtime.recordEvent({
            kind: 'message',
            topic: 'rallar.browser.ws.message',
            connection: 'almConformanceReceiver',
            payload: { data: { typeId: 'alm.conformance.ws.delivery-baseline', payload: { marker: 'delivery-baseline' } } }
        });
        runtime.recordEvent({
            kind: 'message',
            topic: 'rallar.browser.rtc.message',
            connection: 'almConformanceReceiver',
            payload: { data: { typeId: `alm.conformance.${carrier}.delivery-baseline`, payload: { marker } } }
        });
        const execution = runtime.execute(payloadWait);
        await vi.runAllTimersAsync();
        const result = await execution;
        expect(result.status).toBe(status);
        if (status === 'failed') {
            expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_TIMEOUT');
        }
        else {
            expect(result.value).toMatchObject({
                event: { payload: { data: { typeId: `alm.conformance.${carrier}.delivery-baseline`, payload: { marker: 'delivery-baseline' } } } }
            });
        }
    });

    it('requires diagnostic conformance connections to record explicitly', () => {
        for (const carrier of ['ws', 'rtc', 'rtc-with-ws-fallback'] as const) {
            const scenarios = AlmRecipes.createAlmConformanceRecipes(toConformanceInput(carrier));
            for (const recipe of scenarios.flatMap((pair) => [pair.sender, pair.receiver, pair.recipientB, pair.successor, pair.sibling])) {
                for (const command of recipe?.commands ?? []) {
                    if (command.kind === 'rtc.connect') {
                        expect(command.rallar?.almDiagnostics, command.commandId).toBe(true);
                    }
                }
            }
        }
    });
});

/** Owns an in-memory delivery transport; recipe execution, matching and assertions stay real. */
class DeliveryLane {
    readonly delivered: RallarBlackBoxTestRecord[] = [];
    private readonly agents = new Map<string, RallarBlackBoxBrowserTestRuntime>();
    private readonly failure: string;

    constructor(failure = '') {
        this.failure = failure;
    }

    async createAgent(role: string): Promise<RallarBlackBoxBrowserTestRuntime> {
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
            readSession: () => ({
                clientId: role,
                username: role,
                sessionId: `${role}-session`,
                accessToken: 'test-token',
                expiresAtEpochMs: 9_999_999_999_999
            }),
            fetch: async () => new Response('{}', { status: 200 }),
            rallarRuntime: this.createPort(role)
        });
        this.agents.set(role, runtime);
        await runtime.execute({ kind: 'configure', config: { runId: 'delivery-test', agentId: role, apiBaseUrl: 'http://test.invalid' } });
        return runtime;
    }

    private createPort(role: string): RallarBlackBoxBrowserRallarRuntime {
        return {
            authenticate: async () => ({ authenticated: true }),
            connect: async (config) => this.connect(role, config),
            send: async () => ({ sent: true }),
            sendMessage: async (send) => this.sendMessage(send),
            observeDelivery: async (handle) => this.receipt(handle),
            readReceipts: async (handle) => this.receipt(handle),
            cancelDelivery: async (handle) => this.receipt(handle),
            submitControl: async () => undefined,
            injectFault: async () => undefined,
            readStorageCounters: async () => ({ total: 0, byOwner: { 'al-admission': 0, 'al-work': 0 }, byKind: {} }),
            readAlmUsage: async () => undefined,
            readCongestionCounters: async () => undefined,
            refreshRoom: async () => undefined,
            waitForRoom: async () => {
                throw new Error('WS pair has no RTC readiness wait.');
            },
            close: async () => ({ closed: true }),
            health: async () => ({ connected: true })
        };
    }

    private connect(role: string, config: RallarBlackBoxBrowserRallarConnectionConfig): RallarBlackBoxTestRecord {
        if (this.failure === 'missing-policy') {
            this.agents.get(role)?.receiveRallarBrowserEvent({
                kind: 'diagnostic',
                topic: 'rallar.browser.connect.phase_completed',
                connection: config.connection,
                data: { phase: 'configure', almDiagnostics: config.rallar.almDiagnostics }
            });
        }
        else {
            this.agents.get(role)?.receiveRallarBrowserEvent({
                kind: 'diagnostic',
                topic: 'rallar.browser.connect.phase_completed',
                connection: config.connection,
                data: { phase: 'rallar-connect', almDiagnostics: this.failure === 'wrong-policy' ? true : config.rallar.almDiagnostics }
            });
        }
        if (this.failure !== 'missing-diagnostics' && config.rallar.almDiagnostics === true) {
            const topics = role === 'sender' ? [ALM_TOPICS[0], ALM_TOPICS[2], ALM_TOPICS[3]] : [ALM_TOPICS[1]];
            for (const topic of topics) {
                this.agents.get(role)?.receiveRallarBrowserEvent({ kind: 'diagnostic', topic, data: {} });
            }
        }
        if (ALM_TOPICS.includes(this.failure)) {
            this.agents.get(role)?.receiveRallarBrowserEvent({ kind: 'diagnostic', topic: this.failure, data: {} });
        }
        return { connected: true, sessionId: `${role}-session` };
    }

    private sendMessage(send: RallarBlackBoxTestRecord): RallarBlackBoxTestRecord {
        const payload = this.failure === 'wrong-payload' ? { marker: 'wrong' } : send.payload;
        this.agents.get('receiver')?.receiveRallarBrowserEvent({
            kind: 'message',
            topic: 'rallar.browser.ws.message',
            connection: 'receiver',
            data: { typeId: send.typeId, msgId: 'message-1', payload }
        });
        if (this.failure === 'duplicate') {
            this.agents.get('receiver')?.receiveRallarBrowserEvent({
                kind: 'message',
                topic: 'rallar.browser.ws.message',
                connection: 'receiver',
                data: { typeId: send.typeId, msgId: 'message-1', payload }
            });
        }
        this.delivered.push({ payload });
        return { handleId: send.handleId, msgId: 'message-1', carrier: send.carrier, status: send.ack === 'all-logical-recipients' ? 'accepted' : 'rejected' };
    }

    private receipt(handle: RallarBlackBoxTestRecord): RallarBlackBoxTestRecord {
        return {
            handleId: handle.handleId,
            state: 'acknowledged',
            submitted: true,
            enqueued: false,
            receiptMode: 'receiver',
            confirmedHopPeerIds: ['receiver-session'],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['receiver-session'],
            confirmedRecipientPeerIds: this.failure === 'bad-receipt' ? [] : ['receiver-session'],
            unconfirmedRecipientPeerIds: [],
            attempts: 1,
            attemptOutcomes: ['sent'],
            attemptCarriers: ['ws'],
            attemptRefusalReasons: []
        };
    }
}

function toNestedCommands(commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestCommand[] {
    return commands.flatMap((command) => {
        if (command.kind === 'loop') {
            return [command, ...toNestedCommands(command.commands)];
        }
        if (command.kind === 'parallel') {
            return [command, ...command.groups.flatMap((group) => toNestedCommands(group.commands))];
        }
        return [command];
    });
}
