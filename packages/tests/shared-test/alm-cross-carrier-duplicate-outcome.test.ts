import {
    describe,
    expect,
    it
} from 'vitest';

import { createBlackBoxRallarCongestionCounters } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-congestion-counters.ts';
import {
    BlackBoxRallarRuntimeDiagnostics,
    createBlackBoxRallarDiagnosticsPorts
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts';
import { blackBoxRallarScopeDiagnosticsOf } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-policy.ts';
import { createBlackBoxRallarOrderingTracks } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-ordering-tracks.ts';
import {
    resolveBlackBoxRallarLaneId,
    resolveBlackBoxRallarTransport
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-policy.ts';
import { toRallarBrowserEventInput } from '@shared-test/rallar-bb-test/browser/to-rallar-browser-event-input.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { createCountingIndexedDbOperationObserver, createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { createScriptedStorageFaultPort } from '@shared/persistence/storage-fault-port.ts';
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

async function readDuplicateDiagnostics(
    order: CrossCarrierOrder,
    arrivals: readonly ALInboundMessageRuntime.Source[]
): Promise<readonly ALInboundRuntimeDiagnosticsEvent[]> {
    const scenario = toCrossCarrierScenario(order);
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
    const message = {
        ...inbound,
        payload: { ...inbound.payload, typeId: `alm.conformance.rtc-with-ws-fallback.${scenario.scenarioKey}` }
    };
    await runtime.ready();
    for (const source of arrivals) {
        await runtime.admitIncomingMessage(message, source);
    }
    await Promise.resolve();
    return diagnostics;
}

function createRecipeDiagnosticsPorts(recipeRuntime: ReturnType<typeof createDefaultRallarBlackBoxTestRuntime>) {
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
    return createBlackBoxRallarDiagnosticsPorts(pageDiagnostics, {
        faults: createScriptedTransportFaultPort(),
        storage: createCountingIndexedDbOperationObserver(),
        storageFaults: createScriptedStorageFaultPort(),
        congestion: createBlackBoxRallarCongestionCounters(),
        orderingTracks: createBlackBoxRallarOrderingTracks()
    });
}

/** Real page diagnostic publication feeds the authored receiver commands after their absence window. */
async function runDiagnosticOutcomeCommands(
    order: CrossCarrierOrder,
    diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]
): Promise<boolean> {
    const scenario = toCrossCarrierScenario(order);
    const recipeRuntime = createDefaultRallarBlackBoxTestRuntime();
    const ports = createRecipeDiagnosticsPorts(recipeRuntime);
    for (const event of diagnostics) {
        ports.inboundDiagnostics?.(event);
    }
    const authored = scenario.receiver.commands;
    const absence = authored.findIndex((command) => command.kind === 'messages.received' && command.absent === true);
    const commands = authored.slice(absence + 1).filter((command) => command.kind !== 'stats');
    expect(commands.length).toBeGreaterThan(0);
    const result = await recipeRuntime.execute({ kind: 'recipe.run', recipe: { ...scenario.receiver, commands } });
    return result.ok;
}

/** Admission and page publication use their production ports; neither matcher nor diagnostics are mocked. */
async function runDuplicateOutcomeCommands(
    order: CrossCarrierOrder,
    arrivals: readonly ALInboundMessageRuntime.Source[]
): Promise<boolean> {
    return runDiagnosticOutcomeCommands(order, await readDuplicateDiagnostics(order, arrivals));
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

    it.each(['rtc-then-ws', 'ws-then-rtc'] as const)('ignores newer routing and wrong-scenario admissions for %s', async (order) => {
        const diagnostics = await readDuplicateDiagnostics(order, [RTC_ARRIVAL, WS_ARRIVAL]);
        const duplicate = diagnostics.find((event) => event.kind === 'admission-outcome' && event.reason === 'duplicate');
        if (duplicate?.kind !== 'admission-outcome') {
            throw new Error('The real duplicate arrival produced no admission outcome.');
        }
        const newerRouting: ALInboundRuntimeDiagnosticsEvent = {
            kind: 'dispatch-decision',
            lane: 'volatile',
            workerId: 'cross-carrier-worker',
            effectId: 'newer-dispatch',
            msgId: duplicate.msgId,
            typeId: duplicate.typeId,
            carrier: 'ws',
            attempts: 1,
            atEpochMs: Date.now(),
            disposition: 'port-returned'
        };
        const wrongScenario: ALInboundRuntimeDiagnosticsEvent = {
            ...duplicate,
            typeId: 'alm.conformance.rtc-with-ws-fallback.other-scenario',
            outcome: 'committed',
            reason: 'admitted'
        };

        expect(await runDiagnosticOutcomeCommands(order, [...diagnostics, newerRouting, wrongScenario])).toBe(true);
        expect(await runDiagnosticOutcomeCommands(order, [newerRouting, wrongScenario])).toBe(false);
    }, WAIT_BUDGET_TEST_TIMEOUT_MS);
});
