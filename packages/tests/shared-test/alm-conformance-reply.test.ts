import { describe, expect, it } from 'vitest';

import { ALM_REPLY_WAIT_RESPONSE_MARGIN_MS } from '@shared-test/rallar-bb-test/alm/browser-adapter-alm-commands.ts';
import type { RallarBlackBoxTestMessagesAwaitReplyResultValue } from '@shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts';
import type { RallarBlackBoxBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { NON_EXPIRING_SEND_TIMEOUT_MS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { readAlmReceiptRolesEntries } from '@shared-test/rallar-bb-test/conformance/alm/assess-alm-receipt-role-identity.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';
import { createBrowserRallarRequiredMethodsTestDouble } from './browser-rallar-required-methods-test-double.ts';

const REPLY_SCENARIO_IDS = ['reply-correlated', 'reply-timeout-late', 'reply-undelivered', 'reply-first-wins'] as const;
const PROLOGUE = ['ensure-group', 'ensure-member', 'connect'] as const;
const ADMISSION = ['send-1', 'observe-admitted-1', 'assert-admitted-1'] as const;
const RECEIPT_READ = [
    'receipts-1',
    'assert-receipt-state-1',
    'assert-receipt-receiptMode-1',
    'assert-receipt-expectedRecipientPeerIds-count-1',
    'assert-receipt-confirmedRecipientPeerIds-count-1',
    'assert-receipt-unconfirmedRecipientPeerIds-count-1'
] as const;
const REPLIED_FACTS = ['await-reply-1', 'assert-reply-replied-1', 'assert-reply-type-1', 'reply-correlation-1', 'reply-identity-1'];
const RESPONDER = ['received-1', 'reply-1', 'observe-reply-acknowledged-1', 'assert-reply-acknowledged-1'] as const;

type ReplyScenarioId = (typeof REPLY_SCENARIO_IDS)[number];

const REPLY_CELLS: Readonly<Record<ReplyScenarioId, Readonly<{ carriers: readonly AlmConformanceCarrier[]; laneFamily: string; }>>> = {
    'reply-correlated': { carriers: ['ws', 'rtc-with-ws-fallback'], laneFamily: 'addressed' },
    'reply-timeout-late': { carriers: ['ws'], laneFamily: 'addressed' },
    'reply-undelivered': { carriers: ['ws'], laneFamily: 'addressed' },
    'reply-first-wins': { carriers: ['ws'], laneFamily: 'three-agent' }
};

/** The answers a fake page gives the sender's tail: the request, its observation and the reply wait's outcome. */
interface SenderPage {
    readonly carrier: AlmConformanceCarrier;
    readonly scenarioKey: ReplyScenarioId;
    readonly replyOutcome: object;
    readonly observation?: object;
    /** Page diagnostics the sender's page stated before its tail runs. */
    readonly pageEvents?: readonly object[];
}

type RepliedOutcome = Extract<RallarBlackBoxTestMessagesAwaitReplyResultValue, { status: 'replied'; }>;

function findScenario(carrier: AlmConformanceCarrier, scenarioId: ReplyScenarioId): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`Missing ${scenarioId} over ${carrier}.`);
    }
    return scenario;
}

function toCommandNames(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    const prefix = `${recipe.recipeId}-`;
    return recipe.commands.map((command) => (command.commandId ?? '').replace(prefix, ''));
}

function findCommand(recipe: RallarBlackBoxTestRecipe, name: string): RallarBlackBoxTestCommand {
    const command = recipe.commands.find((candidate) => candidate.commandId === `${recipe.recipeId}-${name}`);
    if (command === undefined) {
        throw new Error(`${recipe.recipeId} has no ${name}.`);
    }
    return command;
}

function isReplyScenario(scenario: AlmConformanceScenario): boolean {
    return REPLY_SCENARIO_IDS.some((scenarioId) => scenarioId === scenario.scenarioId);
}

function toObservation(handleId: string, carrier: AlmConformanceCarrier): object {
    return {
        handleId,
        state: 'acknowledged',
        submitted: true,
        enqueued: false,
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        receiptMode: 'receiver',
        expectedRecipientPeerIds: ['receiver-session'],
        confirmedRecipientPeerIds: ['receiver-session'],
        unconfirmedRecipientPeerIds: [],
        attempts: 1,
        attemptOutcomes: ['sent'],
        attemptCarriers: [carrier === 'ws' ? 'ws' : 'rtc'],
        attemptRefusalReasons: [],
        reason: undefined
    };
}

function toRepliedOutcome(carrier: AlmConformanceCarrier, scenarioKey: ReplyScenarioId, senderId: string): RepliedOutcome {
    return {
        handleId: `alm-${carrier}-${scenarioKey}-send-1`,
        status: 'replied',
        state: 'acknowledged',
        corrId: 'request-1',
        reply: {
            msgId: 'reply-1',
            replyToMsgId: 'request-1',
            corrId: 'request-1',
            senderId,
            typeId: `alm.conformance.${carrier}.${scenarioKey}`,
            traceId: 'trace-reply-1'
        }
    };
}

/** The sender's page as a recipe sees it: the request is `request-1`, and every other answer is the case's. */
function createSenderPage(page: SenderPage): RallarBlackBoxBrowserRallarRuntime {
    const handleId = `alm-${page.carrier}-${page.scenarioKey}-send-1`;
    const observation = page.observation ?? toObservation(handleId, page.carrier);
    return {
        ...createBrowserRallarRequiredMethodsTestDouble(),
        connect: async () => ({ connected: true }),
        send: async () => ({ sent: true }),
        sendMessage: async (input) => ({
            handleId: String(input.handleId),
            msgId: `request-${String(input.handleId).at(-1)}`,
            carrier: page.carrier,
            status: 'acknowledged',
            traceId: 'trace-request-1',
            corrId: `request-${String(input.handleId).at(-1)}`
        }),
        // An observe for one state reads it reached; an admission wait reads the request accepted.
        observeDelivery: async (input) => ({
            ...observation,
            state: Array.isArray(input.state) && input.state.length === 1 ? input.state[0] : 'accepted'
        }),
        readReceipts: async () => observation,
        injectFault: async () => undefined,
        awaitReply: async () => page.replyOutcome,
        refreshRoom: async () => undefined,
        close: async () => ({ closed: true }),
        health: async () => ({ connected: true })
    };
}

/**
 * Runs the sender's commands after its prologue through the real browser adapter against one fake page. Every page
 * event is stated before the run, so each wait reads the history at once instead of spending its budget.
 */
async function runSenderTail(recipe: RallarBlackBoxTestRecipe, page: SenderPage): Promise<boolean> {
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
        readSession: () => undefined,
        rallarRuntime: createSenderPage(page)
    });
    for (const event of page.pageEvents ?? []) {
        runtime.receiveRallarBrowserEvent({ kind: 'diagnostic', topic: 'rallar.browser.alm.inbound_diagnostics', data: event });
    }
    const commands = recipe.commands
        .filter((command) =>
            !['http.request', 'rtc.connect', 'storage.counters', 'stats'].includes(command.kind) &&
            !(command.kind === 'messages.received' && command.absent === true)
        )
        .map((command) => command.kind === 'wait' ? { ...command, timeoutMs: 0 } : command);
    return (await runtime.execute({ kind: 'recipe.run', recipe: { ...recipe, commands } })).ok;
}

describe('reply conformance scenarios', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('catalogs the %s reply cells in the full tag only, each on its lane family', (carrier) => {
        const cells = createAlmConformanceRecipes(toConformanceInput(carrier))
            .filter(isReplyScenario)
            .map(({ scenarioId, laneFamily, roles, tags }) => ({ scenarioId, laneFamily, roles, tags }));

        expect(cells).toEqual(
            REPLY_SCENARIO_IDS.filter((scenarioId) => REPLY_CELLS[scenarioId].carriers.includes(carrier)).map((scenarioId) => ({
                scenarioId,
                laneFamily: REPLY_CELLS[scenarioId].laneFamily,
                roles: REPLY_CELLS[scenarioId].laneFamily === 'three-agent' ? ['sender', 'receiver', 'recipient-b'] : ['sender', 'receiver'],
                tags: ['full']
            }))
        );
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s reply cell identities no other scenario of the run shares, each a valid command', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const toRecipes = (scenario: AlmConformanceScenario) =>
            [scenario.sender, scenario.receiver, scenario.recipientB, scenario.successor, scenario.sibling]
                .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined);
        const others = new Set(
            scenarios.filter((scenario) => !isReplyScenario(scenario)).flatMap(toRecipes)
                .flatMap((recipe) => recipe.commands.flatMap((command) => [command.commandId, 'handleId' in command ? command.handleId : undefined]))
                .filter((identity): identity is string => identity !== undefined)
        );
        const own = scenarios.filter(isReplyScenario).flatMap(toRecipes).flatMap((recipe) => recipe.commands);

        expect(own.flatMap((command) => command.commandId ?? []).filter((commandId) => others.has(commandId))).toEqual([]);
        expect(
            own.flatMap((command) => 'handleId' in command && command.handleId !== undefined ? [command.handleId] : []).filter((handleId) =>
                others.has(handleId)
            )
        )
            .toEqual([]);
        expect(new Set(own.map((command) => command.commandId)).size).toBe(own.length);
        for (const command of own) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});

describe('reply-correlated', () => {
    it.each(REPLY_CELLS['reply-correlated'].carriers)(
        'awaits the reply to a command for the receiver over %s and pins its correlation and its sender, the receiver',
        (carrier) => {
            const scenario = findScenario(carrier, 'reply-correlated');
            const requestMsgId = `{resultCache.alm-${carrier}-reply-correlated-sender-send-1.value.msgId}`;

            expect(toCommandNames(scenario.sender)).toEqual([
                ...PROLOGUE,
                'storage-counters-connected',
                ...ADMISSION,
                'observe-acknowledged-1',
                'assert-addressee-state-1',
                'assert-addressee-receiptMode-1',
                'assert-addressee-expectedRecipientPeerIds-count-1',
                'assert-addressee-confirmedRecipientPeerIds-count-1',
                'receipts-1',
                ...REPLIED_FACTS,
                'stats'
            ]);
            expect(findCommand(scenario.sender, 'send-1')).toMatchObject({ toPeer: 'receiver', ack: 'receiver', carrier });
            expect(findCommand(scenario.sender, 'await-reply-1')).toEqual({
                kind: 'messages.awaitReply',
                commandId: `alm-${carrier}-reply-correlated-sender-await-reply-1`,
                connection: 'sender',
                handleId: `alm-${carrier}-reply-correlated-send-1`,
                timeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS + ALM_REPLY_WAIT_RESPONSE_MARGIN_MS
            });
            expect(findCommand(scenario.sender, 'reply-identity-1')).toMatchObject({
                kind: 'wait',
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.bb.messages.reply_awaited',
                    commandId: `alm-${carrier}-reply-correlated-sender-await-reply-1`,
                    payloadPath: 'data',
                    contains: `"replyToMsgId":"${requestMsgId}","corrId":"${requestMsgId}","senderId":` +
                        `"{resultCache.alm-${carrier}-reply-correlated-sender-observe-acknowledged-1.value.confirmedRecipientPeerIds.0}"`
                }
            });
            expect(readAlmReceiptRolesEntries(scenario.sender)).toEqual([
                { handleId: `alm-${carrier}-reply-correlated-send-1`, confirmed: ['receiver'], unconfirmed: [] }
            ]);
            expect(toCommandNames(scenario.receiver)).toEqual([...PROLOGUE, ...RESPONDER, 'stats']);
            expect(findCommand(scenario.receiver, 'reply-1')).toEqual({
                kind: 'messages.reply',
                commandId: `alm-${carrier}-reply-correlated-receiver-reply-1`,
                connection: 'receiver',
                typeId: `alm.conformance.${carrier}.reply-correlated`,
                index: 1,
                payload: { marker: 'reply-correlated', carrier, role: 'receiver' },
                handleId: `alm-${carrier}-reply-correlated-receiver-reply-1`
            });
            expect(findCommand(scenario.receiver, 'observe-reply-acknowledged-1')).toMatchObject({
                kind: 'messages.observe',
                handleId: `alm-${carrier}-reply-correlated-receiver-reply-1`,
                state: ['acknowledged']
            });
        }
    );

    it('passes the sender\'s tail on a reply correlated to the request from the receiver, and fails it on each fact changed', async () => {
        const sender = findScenario('ws', 'reply-correlated').sender;
        const replied = toRepliedOutcome('ws', 'reply-correlated', 'receiver-session');
        const page = { carrier: 'ws', scenarioKey: 'reply-correlated' } as const;

        expect(await runSenderTail(sender, { ...page, replyOutcome: replied })).toBe(true);
        const changes = [
            { status: 'timeout' },
            { corrId: 'request-0' },
            { reply: { ...replied.reply, replyToMsgId: 'request-0' } },
            { reply: { ...replied.reply, corrId: 'request-0' } },
            { reply: { ...replied.reply, senderId: 'recipient-b-session' } },
            { reply: { ...replied.reply, typeId: 'alm.conformance.ws.other' } }
        ];
        for (const change of changes) {
            expect(await runSenderTail(sender, { ...page, replyOutcome: { ...replied, ...change } }), JSON.stringify(change)).toBe(false);
        }
    });
});

describe('reply-timeout-late', () => {
    it('reads a timeout on an acknowledged request, then releases the receiver, whose reply the sender drops as late', async () => {
        const scenario = findScenario('ws', 'reply-timeout-late');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            ...ADMISSION,
            'observe-acknowledged-1',
            'await-reply-1',
            'assert-reply-timeout-1',
            'assert-reply-request-acknowledged-1',
            'send-2',
            'observe-admitted-2',
            'assert-admitted-2',
            'reply-late-timed-out-1',
            'stats'
        ]);
        expect(findCommand(scenario.sender, 'await-reply-1')).toMatchObject({ timeoutMs: 1_000 + ALM_REPLY_WAIT_RESPONSE_MARGIN_MS });
        expect(findCommand(scenario.sender, 'send-2')).toMatchObject({ toPeer: 'receiver', ack: 'receiver' });
        expect(findCommand(scenario.sender, 'reply-late-timed-out-1')).toMatchObject({
            kind: 'wait',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                payloadFields: { 'data.kind': 'reply-late', 'data.typeId': 'alm.conformance.ws.reply-timeout-late', 'data.cause': 'timed-out' },
                payloadPath: 'data',
                contains: '"replyToMsgId":"{resultCache.alm-ws-reply-timeout-late-sender-send-1.value.msgId}"'
            }
        });
        expect(toCommandNames(scenario.receiver)).toEqual([...PROLOGUE, 'received-1', 'received-2', ...RESPONDER.slice(1), 'stats']);
        expect(findCommand(scenario.receiver, 'received-2')).toMatchObject({ count: 2, absent: false });
        expect(findCommand(scenario.receiver, 'reply-1')).toMatchObject({ index: 1 });

        const timedOut = { handleId: 'alm-ws-reply-timeout-late-send-1', status: 'timeout', state: 'acknowledged', corrId: 'request-1' };
        const late = {
            kind: 'reply-late',
            msgId: 'reply-1',
            replyToMsgId: 'request-1',
            corrId: 'request-1',
            typeId: 'alm.conformance.ws.reply-timeout-late',
            senderId: 'receiver-session',
            carrier: 'ws',
            cause: 'timed-out'
        };
        const page = { carrier: 'ws', scenarioKey: 'reply-timeout-late', replyOutcome: timedOut } as const;
        expect(await runSenderTail(scenario.sender, { ...page, pageEvents: [late] })).toBe(true);
        expect(await runSenderTail(scenario.sender, { ...page, pageEvents: [{ ...late, cause: 'replied' }] })).toBe(false);
        expect(await runSenderTail(scenario.sender, { ...page, replyOutcome: { ...timedOut, state: 'transport-accepted' }, pageEvents: [late] }))
            .toBe(false);
    });
});

describe('reply-undelivered', () => {
    it('drops the request on WS and arms the reply wait at admission, which its short deadline ends undelivered on the expired request', async () => {
        const scenario = findScenario('ws', 'reply-undelivered');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'fault-ws',
            ...ADMISSION,
            'await-reply-1',
            'assert-reply-undelivered-1',
            'assert-reply-request-expired-1',
            'release-ws',
            'stats'
        ]);
        expect(findCommand(scenario.sender, 'fault-ws')).toMatchObject({
            kind: 'fault.inject',
            carrier: 'ws',
            match: { typeId: 'alm.conformance.ws.reply-undelivered' },
            action: 'drop',
            remaining: 'until-cleared'
        });
        expect(findCommand(scenario.sender, 'release-ws')).toMatchObject({ kind: 'fault.inject', remaining: 0 });
        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({ toPeer: 'receiver', ttlMs: 7_500 });
        expect(findCommand(scenario.sender, 'await-reply-1')).toMatchObject({
            timeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS + ALM_REPLY_WAIT_RESPONSE_MARGIN_MS
        });
        expect(toCommandNames(scenario.receiver)).toEqual([...PROLOGUE, 'received-1', 'stats']);
        expect(findCommand(scenario.receiver, 'received-1')).toMatchObject({ count: 1, absent: true });

        const undelivered = { handleId: 'alm-ws-reply-undelivered-send-1', status: 'undelivered', state: 'expired', corrId: 'request-1' };
        const page = { carrier: 'ws', scenarioKey: 'reply-undelivered', replyOutcome: undelivered } as const;
        expect(await runSenderTail(scenario.sender, page)).toBe(true);
        expect(await runSenderTail(scenario.sender, { ...page, replyOutcome: { ...undelivered, status: 'timeout' } })).toBe(false);
        expect(await runSenderTail(scenario.sender, { ...page, replyOutcome: { ...undelivered, state: 'failed' } })).toBe(false);
    });
});

describe('reply-first-wins', () => {
    const observation = {
        ...toObservation('alm-ws-reply-first-wins-send-1', 'ws'),
        expectedRecipientPeerIds: ['receiver-session', 'recipient-b-session'],
        confirmedRecipientPeerIds: ['receiver-session', 'recipient-b-session']
    };

    it('awaits one reply to a room request both recipients answer, pins the other late and its sender among the confirmed', async () => {
        const scenario = findScenario('ws', 'reply-first-wins');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            ...ADMISSION,
            ...REPLIED_FACTS,
            'reply-late-replied-1',
            'received-self-1',
            ...RECEIPT_READ,
            'reply-sender-confirmed-1',
            'stats'
        ]);
        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({ ack: 'all-logical-recipients', ttlMs: 30_000 });
        expect(findCommand(scenario.sender, 'send-1')).not.toHaveProperty('toPeer');
        expect(findCommand(scenario.sender, 'reply-sender-confirmed-1')).toMatchObject({
            kind: 'wait',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.bb.messages.receipts',
                commandId: 'alm-ws-reply-first-wins-sender-receipts-1',
                payloadPath: 'data.confirmedRecipientPeerIds',
                contains: '"{resultCache.alm-ws-reply-first-wins-sender-await-reply-1.value.reply.senderId}"'
            }
        });
        expect(readAlmReceiptRolesEntries(scenario.sender)).toEqual([
            { handleId: 'alm-ws-reply-first-wins-send-1', confirmed: ['receiver', 'recipient-b'], unconfirmed: [] }
        ]);
        for (const recipient of [scenario.receiver, scenario.recipientB]) {
            expect(recipient && toCommandNames(recipient)).toEqual([...PROLOGUE, ...RESPONDER, 'received-2', 'stats']);
            expect(recipient && findCommand(recipient, 'received-2')).toMatchObject({ count: 2, absent: true });
        }
        expect(scenario.recipientB && findCommand(scenario.recipientB, 'reply-1')).toMatchObject({
            handleId: 'alm-ws-reply-first-wins-recipient-b-reply-1',
            payload: { marker: 'reply-first-wins', carrier: 'ws', role: 'recipient-b' }
        });

        const late = {
            kind: 'reply-late',
            msgId: 'reply-2',
            replyToMsgId: 'request-1',
            corrId: 'request-1',
            typeId: 'alm.conformance.ws.reply-first-wins',
            senderId: 'receiver-session',
            carrier: 'ws',
            cause: 'replied'
        };
        const page = {
            carrier: 'ws',
            scenarioKey: 'reply-first-wins',
            observation,
            replyOutcome: toRepliedOutcome('ws', 'reply-first-wins', 'recipient-b-session'),
            pageEvents: [late]
        } as const;
        expect(await runSenderTail(scenario.sender, page)).toBe(true);
        expect(await runSenderTail(scenario.sender, { ...page, replyOutcome: toRepliedOutcome('ws', 'reply-first-wins', 'sender-session') })).toBe(false);
        expect(await runSenderTail(scenario.sender, { ...page, pageEvents: [{ ...late, cause: 'timed-out' }] })).toBe(false);
    });
});
