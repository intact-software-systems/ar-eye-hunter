import { describe, expect, it } from 'vitest';

import {
    BlackBoxRallarRuntimeDiagnostics,
    createBlackBoxRallarDiagnosticsPorts
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts';
import { blackBoxRallarScopeDiagnosticsOf } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-policy.ts';
import {
    resolveBlackBoxRallarLaneId,
    resolveBlackBoxRallarTransport
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-policy.ts';
import { toRallarBrowserEventInput } from '@shared-test/rallar-bb-test/browser/to-rallar-browser-event-input.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createCountingIndexedDbOperationObserver, createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SENDER_PEER_ID
} from '../shared/alm/inbound-runtime-test-fixture.ts';

type CrossCarrierOrder = 'rtc-then-ws' | 'ws-then-rtc';

const RTC_ARRIVAL: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID };
const WS_ARRIVAL: ALInboundMessageRuntime.Source = { kind: 'trusted-server' };

function toCrossCarrierScenario(order: CrossCarrierOrder): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes({
        group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
        carrier: 'rtc-with-ws-fallback',
        typeId: 'alm.conformance',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 18_000
    }).find((candidate) => candidate.scenarioKey === `cross-carrier-duplicate-${order}`);
    if (!scenario) {
        throw new Error(`The generator produced no cross-carrier-duplicate-${order} pair.`);
    }
    return scenario;
}

/**
 * One message admitted once per arrival, in order, through the real inbound runtime's `admission-outcome` emitter
 * and the page runtime's diagnostics port into a recipe runtime's event buffer; then only the receiver commands
 * after its absence window, the duplicate-outcome check, run against that buffer.
 */
async function runDuplicateOutcomeCommands(
    order: CrossCarrierOrder,
    arrivals: readonly ALInboundMessageRuntime.Source[]
): Promise<boolean> {
    const scenario = toCrossCarrierScenario(order);
    const recipeRuntime = createRallarBlackBoxTestRuntime();
    const pageDiagnostics = new BlackBoxRallarRuntimeDiagnostics({
        now: Date.now,
        publish: (event) => {
            recipeRuntime.recordEvent(toRallarBrowserEventInput({
                ...event,
                roomRef: event.roomRef ? { ...event.roomRef } : undefined,
                scope: event.scope ? { ...event.scope } : undefined
            }));
        },
        onPublishError: (error) => {
            throw error;
        },
        transportOf: resolveBlackBoxRallarTransport,
        laneIdOf: resolveBlackBoxRallarLaneId,
        scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf
    });
    const ports = createBlackBoxRallarDiagnosticsPorts(pageDiagnostics, {
        faults: createScriptedTransportFaultPort(),
        storage: createCountingIndexedDbOperationObserver()
    });
    const { runtime, diagnostics } = createInboundTestRuntime({
        carrier: 'rtc',
        stores: createInboundTestStores({
            namespace: `cross-carrier-duplicate-${order}`,
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: 'cross-carrier-worker'
    });
    const inbound = createInboundTestMessage({ msgId: `cross-carrier-${order}` });
    const message = { ...inbound, payload: { ...inbound.payload, typeId: `alm.conformance.rtc-with-ws-fallback.${scenario.scenarioKey}` } };
    await runtime.ready();
    for (const source of arrivals) {
        await runtime.admitIncomingMessage(message, source);
    }
    for (const event of diagnostics) {
        ports.inboundDiagnostics?.(event);
    }
    await Promise.resolve();
    const authored = scenario.receiver.commands;
    const absence = authored.findIndex((command) => command.kind === 'messages.received' && command.absent === true);
    const commands = authored.slice(absence + 1).filter((command) => command.kind !== 'stats');
    expect(commands.length).toBeGreaterThan(0);
    const result = await recipeRuntime.execute({ kind: 'recipe.run', recipe: { ...scenario.receiver, commands } });
    return result.ok;
}

/** An absent branch spends its whole wall-clock wait budget, so each case that fails takes about two seconds. */
const WAIT_BUDGET_TEST_TIMEOUT_MS = 15_000;

describe('the cross-carrier duplicate outcome wait', () => {
    it('matches the emitter\'s admission-outcome for the pair\'s refused WS copy in rtc-then-ws, and nothing else', async () => {
        expect(await runDuplicateOutcomeCommands('rtc-then-ws', [RTC_ARRIVAL, WS_ARRIVAL])).toBe(true);
        expect(await runDuplicateOutcomeCommands('rtc-then-ws', [WS_ARRIVAL, RTC_ARRIVAL])).toBe(false);
        expect(await runDuplicateOutcomeCommands('rtc-then-ws', [RTC_ARRIVAL])).toBe(false);
    }, WAIT_BUDGET_TEST_TIMEOUT_MS);

    it('accepts the refused copy on either carrier in ws-then-rtc, and fails when neither arrived twice', async () => {
        expect(await runDuplicateOutcomeCommands('ws-then-rtc', [WS_ARRIVAL, RTC_ARRIVAL])).toBe(true);
        expect(await runDuplicateOutcomeCommands('ws-then-rtc', [RTC_ARRIVAL, WS_ARRIVAL])).toBe(true);
        expect(await runDuplicateOutcomeCommands('ws-then-rtc', [WS_ARRIVAL])).toBe(false);
    }, WAIT_BUDGET_TEST_TIMEOUT_MS);
});
