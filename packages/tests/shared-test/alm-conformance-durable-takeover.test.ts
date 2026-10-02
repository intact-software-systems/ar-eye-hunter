import {
    describe,
    expect,
    it
} from 'vitest';

import { toBrowserRtcOverlayALRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import { AL_OUTBOUND_WORK_LEASE_MS } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';

import {
    CONNECT_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-budgets.ts';
import {
    ALM_CONFORMANCE_CARRIERS,
    type AlmConformanceCarrier
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { decodePayloadPathValue } from '@shared-test/rallar-bb-test/wait/wait-event-match.ts';

import { OUTBOUND_LEASE_RECOVERY_BOUND_MS } from '../shared/alm/outbound-runtime-test-fixture.ts';
import { toConformanceInput } from './alm-conformance-test-input.ts';

const STORAGE_TOPIC = 'rallar.browser.alm.storage';

function findTakeover(carrier: AlmConformanceCarrier): AlmConformanceScenario & { readonly successor: RallarBlackBoxTestRecipe; } {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioId === 'durable-takeover');
    if (scenario?.successor === undefined) {
        throw new Error(`Missing durable-takeover with a successor over ${carrier}.`);
    }
    return { ...scenario, successor: scenario.successor };
}

/** The scenario's own commands, past the connect prologue and before the trailing stats. */
function toScenarioCommands(commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestCommand[] {
    return commands.filter((command) => !['http.request', 'rtc.connect', 'storage.counters', 'stats'].includes(command.kind));
}

function toShape(command: RallarBlackBoxTestCommand): string {
    switch (command.kind) {
        case 'fault.inject':
            return `fault.inject:${command.carrier}:${String(command.remaining)}`;
        case 'messages.send':
            return 'replayOnCarrier' in command ? 'replay' : `send:${command.durability ?? 'volatile'}:${command.ack ?? 'none'}`;
        case 'messages.observe':
            return `observe:${command.state.length === 1 ? command.state[0] : 'admitted'}`;
        case 'messages.received':
            return `received:${command.count}${command.absent === true ? ':absent' : ''}`;
        case 'wait':
            return `wait:${command.match.kind}${command.absent === true ? ':absent' : ''}`;
        default:
            return command.kind;
    }
}

function findSend(scenario: AlmConformanceScenario) {
    const send = scenario.sender.commands.find((command) => command.kind === 'messages.send');
    if (send?.kind !== 'messages.send' || 'replayOnCarrier' in send) {
        throw new Error(`${scenario.scenarioKey} sends nothing.`);
    }
    return send;
}

describe('durable-takeover conformance scenario', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('runs over %s on two pages of the sender\'s context, in the full tag only', (carrier) => {
        const scenario = findTakeover(carrier);

        expect(scenario.laneFamily).toBe('same-context');
        expect(scenario.roles).toEqual(['sender', 'receiver', 'successor']);
        expect(scenario.tags).toEqual(['full']);
        expect(scenario.recipientB).toBeUndefined();
        expect(scenario.successor.recipeId).toBe(`alm-${carrier}-durable-takeover-successor`);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('has the %s owner admit and retain one durable send under a held carrier', (carrier) => {
        const holds = carrier === 'rtc-with-ws-fallback'
            ? ['fault.inject:rtc:until-cleared', 'fault.inject:ws:until-cleared']
            : [`fault.inject:${carrier}:until-cleared`];

        expect(toScenarioCommands(findTakeover(carrier).sender.commands).map(toShape)).toEqual([
            ...holds,
            'send:local-outbox:receiver',
            'observe:admitted',
            'assert',
            'assert',
            'assert',
            'assert',
            ...(carrier === 'rtc-with-ws-fallback' ? ['loop'] : [])
        ]);
    });

    // The owner's page closes as its recipe ends; over the fallback carrier the row must be in the WS store by then.
    it('has the fallback owner poll its receipt until a WS attempt follows the hand-over', () => {
        const scenario = findTakeover('rtc-with-ws-fallback');
        const poll = scenario.sender.commands.at(-2);
        const [receipts, handedOver, wsAttempt, ...rest] = poll?.kind === 'loop' ? poll.commands : [];

        expect(poll).toMatchObject({ kind: 'loop', until: 'first-success', intervalMs: 200 });
        expect(poll?.kind === 'loop' ? (poll.count ?? 0) * (poll.intervalMs ?? 0) : 0).toBe(NON_EXPIRING_SEND_TIMEOUT_MS);
        expect(receipts).toMatchObject({ kind: 'messages.receipts', handleId: findSend(scenario).handleId });
        expect(handedOver).toMatchObject({ kind: 'assert', operator: 'equals', expected: 'ws' });
        expect(wsAttempt).toMatchObject({ kind: 'assert', operator: 'contains', expected: 'ws' });
        expect(rest).toEqual([]);
    });

    // The hand-over is recorded before the WS row commits; only a WS attempt proves the row reached the WS store.
    it.each(
        [
            [['none', 'handed-over', 'ws-attempt'], true, 3],
            [['handed-over', 'handed-over', 'handed-over'], false, 3],
            [['none', 'none', 'none'], false, 3]
        ] as const
    )('ends the fallback owner\'s poll on the first receipt with a WS attempt (receipts %j, passes %s)', async (stages, passes, expectedReads) => {
        const poll = findTakeover('rtc-with-ws-fallback').sender.commands.at(-2);
        let reads = 0;
        const runtime = createRallarBlackBoxTestRuntime({
            sleep: async () => {},
            commandExecutor: (command) => {
                if (command.kind !== 'messages.receipts') {
                    return undefined;
                }
                const stage = stages[Math.min(reads, stages.length - 1)];
                reads += 1;
                return {
                    status: 'ok',
                    value: {
                        carrierFallback: stage === 'none' ? undefined : { from: 'rtc', to: 'ws' },
                        attemptCarriers: stage === 'ws-attempt' ? ['rtc', 'ws'] : ['rtc']
                    }
                };
            }
        });

        const result = await runtime.execute(poll?.kind === 'loop' ? { ...poll, count: stages.length } : { kind: 'health' });

        expect(result.ok).toBe(passes);
        expect(reads).toBe(expectedReads);
    });

    it.each(['ws', 'rtc'] as const)('ends the %s owner\'s commands at its retained evidence', (carrier) => {
        expect(findTakeover(carrier).sender.commands.some((command) => command.kind === 'loop')).toBe(false);
    });

    // The owner's page closes with its row held: the successor takes it over, at once or after one lease and a sweep.
    it.each(ALM_CONFORMANCE_CARRIERS)('lets the %s original outlive one lease, the recovery bound and a successor connect', (carrier) => {
        const send = findSend(findTakeover(carrier));

        expect(send.payload).toEqual({ marker: 'durable-takeover', carrier });
        expect(send.ttlMs).toBeGreaterThan(AL_OUTBOUND_WORK_LEASE_MS + OUTBOUND_LEASE_RECOVERY_BOUND_MS + CONNECT_TIMEOUT_MS);
    });

    // A held claim stays reserved until its lease ends, so the successor connects only once the owner's lease has lapsed.
    it.each(
        [
            ['ws', 'browser-ws-client'],
            ['rtc', 'browser-rtc-overlay'],
            ['rtc-with-ws-fallback', 'browser-ws-client']
        ] as const
    )('has the %s successor wait out the owner\'s lease, restore its session and read %s restored with a claim', (carrier, originalStore) => {
        const { successor } = findTakeover(carrier);
        const prefix = `alm-${carrier}-durable-takeover-successor`;
        const [, , lapse, connect, recovery, claimed] = successor.commands;

        expect(successor.commands.map((command) => command.commandId)).toEqual([
            `${prefix}-ensure-group`,
            `${prefix}-ensure-member`,
            `${prefix}-owner-lease-lapses`,
            `${prefix}-connect`,
            `${prefix}-recovered-original-store`,
            `${prefix}-assert-recovered-claimed`,
            `${prefix}-stats`
        ]);
        expect(lapse?.kind === 'wait' && lapse.absent === true).toBe(true);
        expect(lapse?.timeoutMs).toBeGreaterThan(AL_OUTBOUND_WORK_LEASE_MS);
        expect(connect?.kind === 'rtc.connect' ? connect.rallar : undefined).toMatchObject({
            username: '',
            password: '',
            restoreSession: true
        });
        expect(recovery?.kind === 'wait' ? recovery.match : undefined).toEqual({
            kind: 'diagnostic',
            topic: STORAGE_TOPIC,
            payloadPath: 'data',
            contains: `"kind":"recovery","storeId":"${originalStore}:{resultCache.${prefix}-connect.value.sessionId}",` +
                '"outcome":{"kind":"restored"'
        });
        expect(claimed).toMatchObject({
            kind: 'assert',
            source: `resultCache.${prefix}-recovered-original-store.value.event.payload.data.outcome.claimed`,
            operator: 'gt',
            expected: 0
        });
    });

    it('reads the claim from the restored recovery a store records, as the runtime keeps the matched event', () => {
        const events: ALStorageEvent[] = [];
        new ALStorageHealth({ storeId: toBrowserRtcOverlayALRuntimeStoreId('s'), storage: (event) => events.push(event) })
            .recordRecovery({ kind: 'restored', claimed: 1, expired: 0 }, undefined);
        const { successor } = findTakeover('rtc');
        const recovery = successor.commands.find((command) => command.commandId?.endsWith('-recovered-original-store'));
        const claimed = successor.commands.find((command) => command.commandId?.endsWith('-assert-recovered-claimed'));
        const contains = recovery?.kind === 'wait' ? recovery.match.contains ?? '' : '';
        const source = claimed?.kind === 'assert' ? claimed.source : '';

        expect(JSON.stringify(events[0]))
            .toContain(contains.replace('{resultCache.alm-rtc-durable-takeover-successor-connect.value.sessionId}', 's'));
        expect(decodePayloadPathValue({ event: { payload: { data: events[0] } } }, source.split('.value.')[1]))
            .toEqual({ exists: true, value: 1 });
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('has the %s receiver get the carrier\'s original once', (carrier) => {
        const scenario = findTakeover(carrier);
        const receiverCommands = toScenarioCommands(scenario.receiver.commands);
        const arrival = receiverCommands[0];

        expect(receiverCommands.map(toShape)).toEqual(['wait:message', 'received:2:absent']);
        expect(arrival?.kind === 'wait' ? arrival.match.equals : undefined).toEqual(findSend(scenario).payload);
        expect(arrival?.timeoutMs).toBe(CONNECT_TIMEOUT_MS + (findSend(scenario).ttlMs ?? 0));
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s command of the three pages its own id the control validator accepts', (carrier) => {
        const scenario = findTakeover(carrier);
        const commands = [...scenario.sender.commands, ...scenario.receiver.commands, ...scenario.successor.commands];

        expect(new Set(commands.map((command) => command.commandId)).size).toBe(commands.length);
        for (const command of commands) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});
