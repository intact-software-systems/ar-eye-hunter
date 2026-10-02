import { describe, expect, it } from 'vitest';

import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import { toALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
import { createScriptedStorageFaultPort } from '@shared/persistence/storage-fault-port.ts';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { RELOAD_RECOVERED_STORE_PREFIXES } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    toBrowserRtcOverlayALRuntimeStoreId,
    toBrowserSessionALInboundRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const STORAGE_TOPIC = 'rallar.browser.alm.storage';

function findScenario(carrier: (typeof ALM_CONFORMANCE_CARRIERS)[number], scenarioId: string): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`Missing ${scenarioId} over ${carrier}.`);
    }
    return scenario;
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
            return 'replayOnCarrier' in command
                ? 'replay'
                : `send:${command.durability ?? 'volatile'}:${command.onStorageUnavailable ?? 'default'}`;
        case 'messages.observe':
            return `observe:${command.state.length === 1 ? command.state[0] : 'admitted'}`;
        case 'wait':
            return `wait:${command.match.kind}${command.absent === true ? ':absent' : ''}`;
        default:
            return command.kind;
    }
}

describe('storage-unavailable conformance scenario', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('runs on two agents over %s in the full tag only', (carrier) => {
        const scenario = findScenario(carrier, 'storage-unavailable');

        expect(scenario.laneFamily).toBe('two-agent');
        expect(scenario.roles).toEqual(['sender', 'receiver']);
        expect(scenario.tags).toEqual(['full']);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'refuses, downgrades, then recovers a durable send under a held %s admission quota',
        (carrier) => {
            const { sender } = findScenario(carrier, 'storage-unavailable');

            expect(toScenarioCommands(sender.commands).map(toShape)).toEqual([
                'fault.inject:storage:until-cleared',
                'fault.inject:storage:until-cleared',
                'send:local-outbox:default',
                'observe:failed',
                'assert',
                'assert',
                'assert',
                'wait:diagnostic',
                'send:local-outbox:volatile',
                'observe:admitted',
                'assert',
                'assert',
                'assert',
                'assert',
                'fault.inject:storage:0',
                'fault.inject:storage:0',
                'send:local-outbox:default',
                'observe:admitted',
                'assert',
                'assert',
                'wait:diagnostic'
            ]);
        }
    );

    // A work write that commits during the hold would record a recovery point and read healthy before the release.
    it('holds a quota on the admission and the work writes, each under its own fault id, and releases both', () => {
        const faults = findScenario('rtc', 'storage-unavailable').sender.commands
            .filter((command) => command.kind === 'fault.inject')
            .map((fault) => ({ faultId: fault.faultId, match: fault.match, action: fault.action, remaining: fault.remaining }));

        expect(faults).toEqual([
            {
                faultId: 'alm.conformance.rtc.storage-unavailable.quota-admission',
                match: { owner: 'al-admission', kind: 'write' },
                action: 'quota',
                remaining: 'until-cleared'
            },
            {
                faultId: 'alm.conformance.rtc.storage-unavailable.quota-work',
                match: { owner: 'al-work' },
                action: 'quota',
                remaining: 'until-cleared'
            },
            {
                faultId: 'alm.conformance.rtc.storage-unavailable.quota-admission',
                match: { owner: 'al-admission', kind: 'write' },
                action: 'quota',
                remaining: 0
            },
            {
                faultId: 'alm.conformance.rtc.storage-unavailable.quota-work',
                match: { owner: 'al-work' },
                action: 'quota',
                remaining: 0
            }
        ]);
    });

    it('asserts the typed refusal, the named downgrade and the recovered commit on the sender\'s handles', () => {
        const asserts = findScenario('ws', 'storage-unavailable').sender.commands
            .filter((command) => command.kind === 'assert')
            .map((command) => [command.source.replace(/^resultCache\.alm-ws-storage-unavailable-sender-/, ''), command.expected]);

        expect(asserts).toEqual([
            ['observe-failed-1.value.failure.kind', 'storage-unavailable'],
            ['observe-failed-1.value.failure.cause', 'quota'],
            ['observe-failed-1.value.submitted', false],
            ['observe-admitted-2.value.state', '^(accepted|queued|transport-accepted|acknowledged)$'],
            ['observe-admitted-2.value.enqueued', false],
            ['observe-admitted-2.value.durabilityDowngrade.requested', 'local-outbox'],
            ['observe-admitted-2.value.durabilityDowngrade.cause', 'quota'],
            ['observe-admitted-3.value.state', '^(accepted|queued|transport-accepted|acknowledged)$'],
            ['observe-admitted-3.value.enqueued', true]
        ]);
    });

    // The detail names one of the cell's two faults, so a cell never matches a transition an earlier cell caused.
    it('reads the store failing, then healthy with a quota of this cell\'s faults still its last failure', () => {
        const waits = findScenario('rtc-with-ws-fallback', 'storage-unavailable').sender.commands
            .filter((command) => command.kind === 'wait');
        const lastFailure = '"lastFailure":{"cause":"quota","detail":"QuotaExceededError: Scripted storage quota fault ' +
            'alm.conformance.rtc-with-ws-fallback.storage-unavailable.quota-';

        expect(waits.map((wait) => wait.match)).toEqual([
            {
                kind: 'diagnostic',
                topic: STORAGE_TOPIC,
                payloadPath: 'data',
                contains: `"status":"failing",${lastFailure}`
            },
            {
                kind: 'diagnostic',
                topic: STORAGE_TOPIC,
                payloadPath: 'data',
                contains: `"status":"healthy",${lastFailure}`
            }
        ]);
    });

    // A work-queue failure can replace the admission one as the store's last failure: either one matches.
    it.each(['al-admission', 'al-work'] as const)(
        'matches the storage failure the scripted %s fault produces, as a store records it',
        async (owner) => {
            const { sender } = findScenario('ws', 'storage-unavailable');
            const fault = sender.commands.find((command) => command.kind === 'fault.inject' && command.carrier === 'storage' && command.match.owner === owner);
            if (fault?.kind !== 'fault.inject' || fault.carrier !== 'storage') {
                throw new Error(`The scenario holds no ${owner} quota.`);
            }
            const port = createScriptedStorageFaultPort();
            port.inject({
                faultId: fault.faultId,
                carrier: 'storage',
                match: { owner: fault.match.owner, kind: fault.match.kind },
                action: 'quota',
                remaining: 'until-cleared'
            });
            const rejection = await Promise.resolve(port.observe({ owner, kind: 'write' }))
                .then(() => new Error('The held quota fault let the write through.'), (error: Error) => error);
            const lastFailure = JSON.stringify({ lastFailure: toALStorageUnavailable(rejection) }).slice(1, -2);
            const failing = sender.commands.find((command) => command.commandId?.endsWith('-health-failing'));

            expect(failing?.kind).toBe('wait');
            expect(`"status":"failing",${lastFailure}`).toContain(failing?.kind === 'wait' ? failing.match.contains : '');
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)('ties each %s health wait to that cell\'s own faults', (carrier) => {
        const waits = findScenario(carrier, 'storage-unavailable').sender.commands
            .filter((command) => command.kind === 'wait');

        for (const wait of waits) {
            expect(wait.match.contains).toMatch(
                new RegExp(`fault alm\\.conformance\\.${carrier.replaceAll('-', '\\-')}\\.storage-unavailable\\.quota-$`)
            );
        }
    });

    // One receiver page hears every cell, so each payload names its carrier.
    it('has the receiver get the downgraded and the recovered send, never the refused one', () => {
        const receiver = findScenario('ws', 'storage-unavailable').receiver;
        const waits = receiver.commands.filter((command) => command.kind === 'wait');

        expect(waits.map((wait) => [wait.match.equals, wait.absent === true])).toEqual([
            [{ marker: 'storage-unavailable', carrier: 'ws', send: '2' }, false],
            [{ marker: 'storage-unavailable', carrier: 'ws', send: '3' }, false],
            [{ marker: 'storage-unavailable', carrier: 'ws', send: '1' }, true]
        ]);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('writes every %s command the control validator accepts', (carrier) => {
        const scenario = findScenario(carrier, 'storage-unavailable');

        for (const command of [...scenario.sender.commands, ...scenario.receiver.commands]) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});

describe('delivery-reload recovery reads', () => {
    it.each(
        [
            ['ws', 'browser-ws-client'],
            ['rtc', 'browser-rtc-overlay'],
            ['rtc-with-ws-fallback', 'browser-rtc-overlay']
        ] as const
    )(
        'waits after the %s reload for one restored recovery of the session inbound store and of %s',
        (carrier, originalStore) => {
            const { sender } = findScenario(carrier, 'delivery-reload');
            const reconnect = sender.commands.findIndex((command) => command.commandId?.endsWith('-sender-reconnect'));
            const recoveries = sender.commands.slice(reconnect).filter((command) => command.kind === 'wait' && command.match.topic === STORAGE_TOPIC);
            const sessionId = `{resultCache.alm-${carrier}-delivery-reload-sender-reconnect.value.sessionId}`;

            expect(recoveries.map((wait) => wait.kind === 'wait' ? wait.match.contains : undefined)).toEqual([
                `"kind":"recovery","storeId":"browser-session-inbound:${sessionId}/ws","outcome":{"kind":"restored"`,
                `"kind":"recovery","storeId":"${originalStore}:${sessionId}","outcome":{"kind":"restored"`
            ]);
            expect(sender.commands.at(-2)?.commandId).toBe(`alm-${carrier}-delivery-reload-sender-storage-counters-recovered`);
        }
    );

    // The session inbound store reports per carrier lane, under the store id the product's health names it by.
    it('names the stores by the browser\'s own store ids', () => {
        const events: ALStorageEvent[] = [];
        new ALStorageHealth({ storeId: toBrowserSessionALInboundRuntimeStoreId('s'), storage: (event) => events.push(event) })
            .recordRecovery({ kind: 'restored', claimed: 0, expired: 0 }, 'ws');

        expect(events.map((event) => event.kind === 'recovery' ? event.storeId : event.kind)).toEqual([
            `${RELOAD_RECOVERED_STORE_PREFIXES.sessionInbound}:s/ws`
        ]);
        expect(`${RELOAD_RECOVERED_STORE_PREFIXES.sessionInbound}:s`).toBe(String(toBrowserSessionALInboundRuntimeStoreId('s')));
        expect(`${RELOAD_RECOVERED_STORE_PREFIXES.ws}:s`).toBe(String(toBrowserWsClientALRuntimeStoreId('s')));
        expect(`${RELOAD_RECOVERED_STORE_PREFIXES.rtc}:s`).toBe(String(toBrowserRtcOverlayALRuntimeStoreId('s')));
    });
});
