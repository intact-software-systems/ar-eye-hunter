import { describe, expect, it } from 'vitest';

import { AL_CHECKPOINT_DEFAULT_SETTINGS } from '@shared/alm/checkpoint/al-checkpoint-settings.ts';
import { AL_OUTBOUND_WORK_LEASE_MS } from '@shared/alm/outbound/al-outbound-work-entry.ts';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    RECOVERED_STORE_PREFIXES,
    toCheckpointStorePrefix
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts';
import { bindAlmReloadPair, toAlmReloadCheckpoints } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const STORAGE_TOPIC = 'rallar.browser.alm.storage';
const CHECKPOINT_SCENARIO_IDS = ['checkpoint-recovery', 'checkpoint-lag', 'flush-on-hide'] as const;

type Carrier = (typeof ALM_CONFORMANCE_CARRIERS)[number];
type CheckpointScenarioId = (typeof CHECKPOINT_SCENARIO_IDS)[number];

function findScenario(carrier: Carrier, scenarioId: CheckpointScenarioId): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`Missing ${scenarioId} over ${carrier}.`);
    }
    return scenario;
}

function toRecipes(scenario: AlmConformanceScenario): readonly RallarBlackBoxTestRecipe[] {
    return [scenario.sender, scenario.receiver, scenario.recipientB, scenario.successor]
        .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined);
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

/** Every identity a scenario mints that a run shares with the other scenarios of its `{runId}`. */
function toMintedIdentities(scenario: AlmConformanceScenario): readonly string[] {
    return toRecipes(scenario).flatMap((recipe) =>
        recipe.commands.flatMap((command) => [
            `command:${command.commandId}`,
            ...(command.kind === 'fault.inject' ? [`fault:${command.faultId}`] : []),
            ...(command.kind === 'messages.send' && !('replayOnCarrier' in command) ? [`handle:${command.handleId}`] : []),
            ...(command.kind === 'http.request' ? [`request:${command.request.path}`] : [])
        ])
    );
}

function toRecoveryMatch(recipe: RallarBlackBoxTestRecipe, storeIdPrefix: string, connectName: string): string {
    return `"kind":"recovery","storeId":"${storeIdPrefix}:{resultCache.${recipe.recipeId}-${connectName}.value.sessionId}",` +
        '"outcome":{"kind":"restored"';
}

describe('local-checkpoint conformance scenarios', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('catalogs the checkpoint scenarios over %s in the full tag only', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier))
            .filter((scenario) => (CHECKPOINT_SCENARIO_IDS as readonly string[]).includes(scenario.scenarioId));

        expect(scenarios.map(({ scenarioId, laneFamily, roles, tags }) => ({ scenarioId, laneFamily, roles, tags })))
            .toEqual([
                { scenarioId: 'checkpoint-recovery', laneFamily: 'two-agent', roles: ['sender', 'receiver'], tags: ['full'] },
                { scenarioId: 'checkpoint-lag', laneFamily: 'two-agent', roles: ['sender', 'receiver'], tags: ['full'] },
                ...(carrier === 'rtc-with-ws-fallback' ? [] : [{
                    scenarioId: 'flush-on-hide',
                    laneFamily: 'same-context',
                    roles: ['sender', 'receiver', 'successor'],
                    tags: ['full']
                }])
            ]);
    });

    it('names the checkpoint stores by the browser\'s checkpoint store ids, the held original\'s by its carrier', () => {
        expect(RECOVERED_STORE_PREFIXES).toMatchObject({
            wsCheckpoint: 'browser-ws-client-checkpoint',
            rtcCheckpoint: 'browser-rtc-overlay-checkpoint'
        });
        expect(ALM_CONFORMANCE_CARRIERS.map(toCheckpointStorePrefix)).toEqual([
            'browser-ws-client-checkpoint',
            'browser-rtc-overlay-checkpoint',
            'browser-ws-client-checkpoint'
        ]);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s checkpoint scenario identities no other scenario of the run shares', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const isCheckpoint = (scenario: AlmConformanceScenario) => (CHECKPOINT_SCENARIO_IDS as readonly string[]).includes(scenario.scenarioId);
        const others = new Set(scenarios.filter((scenario) => !isCheckpoint(scenario)).flatMap(toMintedIdentities));
        const own = scenarios.filter(isCheckpoint).flatMap(toMintedIdentities);

        expect(own.filter((identity) => others.has(identity))).toEqual([]);
        for (const command of scenarios.filter(isCheckpoint).flatMap(toRecipes).flatMap((recipe) => recipe.commands)) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});

describe('checkpoint-recovery', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('proves one %s checkpoint before the reload, then the restored row once', (carrier) => {
        const { sender, receiver } = findScenario(carrier, 'checkpoint-recovery');
        const holds = carrier === 'rtc-with-ws-fallback' ? ['checkpoint-hold-rtc', 'checkpoint-hold-ws'] : [`checkpoint-hold-${carrier}`];

        expect(toCommandNames(sender)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'storage-counters-connected',
            'health-before',
            ...holds,
            'storage-counters-before-send',
            'send-1',
            'observe-admitted-1',
            'assert-admitted-1',
            'assert-enqueued-1',
            'assert-retained-1',
            'assert-unsubmitted-1',
            'checkpoint-interval-elapses',
            'storage-counters-checkpointed',
            'assert-checkpoint-write',
            'reload',
            'owner-lease-lapses',
            'reconnect',
            'observe-unobservable-1',
            'assert-old-handle-unobservable',
            'recovered-checkpoint-store',
            'assert-recovered-claimed',
            'stats'
        ]);
        expect(toCommandNames(receiver)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'health-before',
            'absent-before-reload',
            'receive-original',
            'health-after',
            'received-1',
            'stats'
        ]);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('sends the %s original local-checkpoint with a lifetime past the reload and one lease', (carrier) => {
        const { sender } = findScenario(carrier, 'checkpoint-recovery');

        expect(findCommand(sender, 'send-1')).toMatchObject({
            kind: 'messages.send',
            durability: 'local-checkpoint',
            ack: 'receiver',
            ttlMs: 77_000,
            payload: { marker: 'checkpoint-recovery', carrier }
        });
        expect(findCommand(sender, 'storage-counters-before-send')).toMatchObject({ kind: 'storage.counters', reset: true });
    });

    // The send path writes nothing, so the first admission write after the reset is the interval's one readwrite.
    it('waits out the interval and reads the checkpoint\'s admission write before the page reloads', () => {
        const { sender } = findScenario('ws', 'checkpoint-recovery');
        const interval = findCommand(sender, 'checkpoint-interval-elapses');

        expect(interval.kind === 'wait' && interval.absent).toBe(true);
        expect(interval.timeoutMs).toBeGreaterThan(AL_CHECKPOINT_DEFAULT_SETTINGS.intervalMs);
        expect(findCommand(sender, 'storage-counters-checkpointed')).toMatchObject({ kind: 'storage.counters', reset: false });
        expect(findCommand(sender, 'assert-checkpoint-write')).toMatchObject({
            kind: 'assert',
            source: 'resultCache.alm-ws-checkpoint-recovery-sender-storage-counters-checkpointed.value.byKind.write',
            operator: 'gt',
            expected: 0
        });
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('authors the %s reload pair around the checkpoint and binds it', (carrier) => {
        const { sender, receiver } = findScenario(carrier, 'checkpoint-recovery');
        const checkpoints = toAlmReloadCheckpoints(sender.metadata?.almReloadCheckpoints);
        const prefix = `alm-${carrier}-checkpoint-recovery`;

        expect(checkpoints).toEqual([{
            key: prefix,
            senderPrefixEnd: `${prefix}-sender-assert-checkpoint-write`,
            senderReload: `${prefix}-sender-reload`,
            senderSuffixEnd: `${prefix}-sender-assert-recovered-claimed`,
            receiverReadyEnd: `${prefix}-receiver-health-before`,
            receiverAbsenceEnd: `${prefix}-receiver-absent-before-reload`,
            receiverRecoveryEnd: `${prefix}-receiver-health-after`
        }]);
        expect(receiver.metadata?.almReloadCheckpoints).toEqual(checkpoints);
        const toRoot = (recipe: RallarBlackBoxTestRecipe, agentId: string) => ({
            kind: 'command' as const,
            protocolVersion: 1 as const,
            runId: 'run',
            agentId,
            commandId: `${agentId}-root`,
            command: { kind: 'recipe.run' as const, recipe, timeoutMs: 240_000 }
        });
        expect(bindAlmReloadPair({ sender: toRoot(sender, 'sender'), receiver: toRoot(receiver, 'receiver') }).left)
            .toBeUndefined();
    });

    // A held row is checkpointed reserved, so the reloaded owner reconnects once its lease has lapsed.
    it.each(ALM_CONFORMANCE_CARRIERS)('reconnects the %s page past the lease and reads its checkpoint store restored with a claim', (carrier) => {
        const { sender } = findScenario(carrier, 'checkpoint-recovery');
        const lapse = findCommand(sender, 'owner-lease-lapses');
        const recovery = findCommand(sender, 'recovered-checkpoint-store');

        expect(lapse.kind === 'wait' && lapse.absent).toBe(true);
        expect(lapse.timeoutMs).toBeGreaterThan(AL_OUTBOUND_WORK_LEASE_MS);
        expect(findCommand(sender, 'reconnect')).toMatchObject({
            kind: 'rtc.connect',
            rallar: { username: '', password: '', restoreSession: true }
        });
        expect(recovery.kind === 'wait' ? recovery.match : undefined).toEqual({
            kind: 'diagnostic',
            topic: STORAGE_TOPIC,
            payloadPath: 'data',
            contains: toRecoveryMatch(sender, toCheckpointStorePrefix(carrier), 'reconnect')
        });
        expect(findCommand(sender, 'assert-recovered-claimed')).toMatchObject({
            kind: 'assert',
            source: `resultCache.${sender.recipeId}-recovered-checkpoint-store.value.event.payload.data.outcome.claimed`,
            operator: 'gt',
            expected: 0
        });
    });
});

describe('checkpoint-lag', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('lags the %s checkpoint under the quota fault, refuses, then recovers', (carrier) => {
        const { sender, receiver } = findScenario(carrier, 'checkpoint-lag');

        expect(toCommandNames(sender)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'storage-counters-connected',
            'quota-admission-hold',
            'quota-work-hold',
            'send-1',
            'observe-admitted-1',
            'assert-admitted-1',
            'health-delayed',
            'health-failing',
            'send-2',
            'observe-failed-2',
            'assert-refused-failure-kind-2',
            'assert-refused-failure-cause-2',
            'assert-refused-submitted-2',
            'quota-admission-release',
            'quota-work-release',
            'health-healthy',
            'send-3',
            'observe-admitted-3',
            'assert-admitted-3',
            'stats'
        ]);
        expect(toCommandNames(receiver)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'receive-1',
            'receive-3',
            'absent-2',
            'stats'
        ]);
    });

    it('admits every send local-checkpoint on the refusing channel and refuses the second with the lag cause', () => {
        const { sender } = findScenario('rtc', 'checkpoint-lag');

        for (const index of [1, 2, 3]) {
            const send = findCommand(sender, `send-${index}`);
            expect(send).toMatchObject({ kind: 'messages.send', durability: 'local-checkpoint' });
            expect(send.kind === 'messages.send' && 'onStorageUnavailable' in send).toBe(false);
        }
        expect(findCommand(sender, 'assert-refused-failure-cause-2')).toMatchObject({ operator: 'equals', expected: 'checkpoint-lag' });
        expect(findCommand(sender, 'assert-refused-failure-kind-2')).toMatchObject({ operator: 'equals', expected: 'storage-unavailable' });
    });

    it.each(
        [
            ['ws', 'browser-ws-client-checkpoint'],
            ['rtc', 'browser-rtc-overlay-checkpoint'],
            ['rtc-with-ws-fallback', 'browser-rtc-overlay-checkpoint']
        ] as const
    )('waits for the %s checkpoint store %s to read delayed, failing with the lag, then healthy', (carrier, store) => {
        const { sender } = findScenario(carrier, 'checkpoint-lag');
        const storeId = `${store}:{resultCache.${sender.recipeId}-connect.value.sessionId}`;
        const toContains = (name: string) => {
            const wait = findCommand(sender, name);
            return wait.kind === 'wait' ? { topic: wait.match.topic, contains: wait.match.contains } : undefined;
        };

        expect(toContains('health-delayed')).toEqual({
            topic: STORAGE_TOPIC,
            contains: `"kind":"health","storeId":"${storeId}","status":"delayed"`
        });
        expect(toContains('health-failing')).toEqual({
            topic: STORAGE_TOPIC,
            contains: `"kind":"health","storeId":"${storeId}","status":"failing","lastFailure":{"cause":"checkpoint-lag"`
        });
        expect(toContains('health-healthy')).toEqual({
            topic: STORAGE_TOPIC,
            contains: `"kind":"health","storeId":"${storeId}","status":"healthy"`
        });
        expect(findCommand(sender, 'health-failing').timeoutMs)
            .toBeGreaterThan(AL_CHECKPOINT_DEFAULT_SETTINGS.lagBoundMs + AL_CHECKPOINT_DEFAULT_SETTINGS.intervalMs);
    });

    it('matches the health events in the order the store emits their keys', () => {
        const { sender } = findScenario('ws', 'checkpoint-lag');
        const event = {
            kind: 'health',
            storeId: 'browser-ws-client-checkpoint:s',
            status: 'failing',
            lastFailure: { cause: 'checkpoint-lag', detail: 'The oldest unsaved change is 10001 ms old.' },
            lastRecoveryPointAtMs: undefined
        };
        const wait = findCommand(sender, 'health-failing');
        const contains = wait.kind === 'wait' ? wait.match.contains ?? '' : '';

        expect(JSON.stringify(event)).toContain(contains.replace('{resultCache.alm-ws-checkpoint-lag-sender-connect.value.sessionId}', 's'));
    });
});

describe('flush-on-hide', () => {
    it.each(['ws', 'rtc'] as const)('has the %s owner admit one held send and end its recipe inside the interval', (carrier) => {
        const { sender } = findScenario(carrier, 'flush-on-hide');

        expect(toCommandNames(sender)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'storage-counters-connected',
            `flush-hold-${carrier}`,
            'storage-counters-before-send',
            'send-1',
            'observe-admitted-1',
            'assert-admitted-1',
            'assert-enqueued-1',
            'assert-retained-1',
            'assert-unsubmitted-1',
            'storage-counters-unflushed',
            'assert-no-interval-write',
            'stats'
        ]);
        expect(findCommand(sender, 'send-1')).toMatchObject({
            durability: 'local-checkpoint',
            ack: 'receiver',
            ttlMs: 77_000,
            payload: { marker: 'flush-on-hide', carrier }
        });
        expect(sender.commands.some((command) => command.kind === 'wait')).toBe(false);
    });

    // The counters are sparse: a kind never counted since the reset is absent, so the witness is the absent write count.
    it('proves the interval had not written when the owner page ended, so the successor\'s row is the flush\'s', () => {
        const { sender } = findScenario('ws', 'flush-on-hide');

        expect(findCommand(sender, 'storage-counters-before-send')).toMatchObject({ kind: 'storage.counters', reset: true });
        expect(findCommand(sender, 'storage-counters-unflushed')).toMatchObject({ kind: 'storage.counters', reset: false });
        expect(findCommand(sender, 'assert-no-interval-write')).toEqual({
            kind: 'assert',
            commandId: `${sender.recipeId}-assert-no-interval-write`,
            source: `resultCache.${sender.recipeId}-storage-counters-unflushed.value.byKind.write`,
            operator: 'exists',
            expected: false,
            timeoutMs: expect.any(Number)
        });
    });

    it.each(['ws', 'rtc'] as const)('has the %s successor restore the checkpoint store with a claim once the lease lapsed', (carrier) => {
        const { successor, receiver } = findScenario(carrier, 'flush-on-hide');
        if (successor === undefined) {
            throw new Error('flush-on-hide declares no successor.');
        }

        expect(toCommandNames(successor)).toEqual([
            'ensure-group',
            'ensure-member',
            'owner-lease-lapses',
            'connect',
            'recovered-checkpoint-store',
            'assert-recovered-claimed',
            'stats'
        ]);
        const recovery = findCommand(successor, 'recovered-checkpoint-store');
        expect(recovery.kind === 'wait' ? recovery.match.contains : undefined)
            .toBe(toRecoveryMatch(successor, toCheckpointStorePrefix(carrier), 'connect'));
        expect(toCommandNames(receiver)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'receive-original',
            'received-1',
            'stats'
        ]);
    });
});
