import { assert, assertEquals } from '@std/assert';

import { toAgentReloadResult } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import {
    ALM_CONFORMANCE_CARRIERS,
    ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    type AlmConformanceCarrier
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { CreateAlmConformanceRecipesInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { toAlmReloadCheckpoints, toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { createAlmConformance2AgentEntry } from '../../rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';
import { createRallarBlackBoxControlService, type RallarBlackBoxControlService } from '../src/control-service.ts';
import { AlmReloadPorts, type PortMessage } from './support/alm-reload-ports.ts';
import {
    assertRight,
    toControlServiceInput,
    toFleetIdentity,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

for (const replacesDocument of [true, false]) {
    Deno.test(`unmodified combined ALM runs every checkpoint and trailing scenario through restored runtime evidence (fresh document=${replacesDocument})`, async () => {
        const manifest = createAlmConformance2AgentEntry().manifest;
        const ports = new AlmReloadPorts(replacesDocument);
        const input = toControlServiceInput({ now: () => ports.now, runtimeRetentionBounds: { commands: 1, results: 1 } });
        let service = createRallarBlackBoxControlService(input);
        const runId = manifest.controlRunId;
        const agents = ['controller-01', 'controller-02'];
        const register = (): void => {
            for (const agentId of agents) {
                service.receiveClientEnvelope(toRegisterEnvelope({ runId, agentId, identity: toFleetIdentity(agentId, manifest.group) }));
            }
        };
        register();
        assertRight(service.createDistributedRun(manifest));
        assertRight(service.stageDistributedRun(manifest.distributedRunId));
        for (const _phase of ['stage', 'barrier']) {
            for (const [index, agentId] of agents.entries()) {
                for (const command of service.takeDispatchableCommands(runId, agentId)) {
                    await executeSegment(service, index === 0 ? ports.sender : ports.receiver, command);
                }
            }
        }
        const started = assertRight(service.startDistributedRun(manifest.distributedRunId));
        const senderRoot = started.commandLinks.find((link) => link.phase === 'start' && link.role === 'sender')!.commandId;
        const root = service.snapshotRun(runId)!.commands.find((command) => command.envelope.commandId === senderRoot)!.envelope;
        const pair = toAlmReloadPair(root.command)!;
        assertEquals(pair.checkpoints.length, 3);
        for (const checkpoint of pair.checkpoints) {
            const [prefix] = service.takeDispatchableCommands(runId, agents[0]);
            const [ready] = service.takeDispatchableCommands(runId, agents[1]);
            await executeSegment(service, ports.receiver, ready);
            await executeSegment(service, ports.sender, prefix);
            const entered = ports.beginAbsence();
            const [absence] = service.takeDispatchableCommands(runId, agents[1]);
            const pending = executeSegment(service, ports.receiver, absence);
            await entered;
            try {
                assertEquals(service.takeDispatchableCommands(runId, agents[0]), [], 'an unfinished real absence wait cannot authorize page replacement');
            }
            finally {
                ports.finishAbsence();
                await pending;
            }
            const snapshot = service.snapshotForPersistence({ commands: 1, results: 1 });
            assert(snapshot.runs[0].results.some((result) => result.commandId === prefix.commandId), 'pending actual prefix evidence survives low bounds');
            const [reload] = service.takeDispatchableCommands(runId, agents[0]);
            assertEquals(reload.command.kind, 'agent.reload');
            assert(reload.command.kind === 'agent.reload');
            const result = toAgentReloadResult({
                commandId: reload.commandId,
                readyTimeoutMs: reload.command.readyTimeoutMs!,
                written: 'written',
                atEpochMs: ports.now
            });
            recordResult(service, reload, result);
            service.markAgentDisconnected(runId, agents[0]);
            ports.replaceSenderDocument();
            service.receiveClientEnvelope(
                toRegisterEnvelope({ runId, agentId: agents[0], completedCommandIds: [reload.commandId], identity: toFleetIdentity(agents[0], manifest.group) })
            );
            const [suffix] = service.takeDispatchableCommands(runId, agents[0]);
            assert(suffix.command.kind === 'recipe.run');
            assertEquals(suffix.command.recipe?.commands.at(-1)?.commandId, checkpoint.senderSuffixEnd);
            await executeSegment(service, ports.sender, suffix);
            const [recovery] = service.takeDispatchableCommands(runId, agents[1]);
            await executeSegment(service, ports.receiver, recovery);
        }
        // The receiver's original generation is fenced until all recovery checkpoints have completed.
        const pending = service.snapshotForPersistence({ commands: 1, results: 1 });
        service = createRallarBlackBoxControlService(input);
        service.restoreSnapshot(pending);
        register();
        const [senderTrailing] = service.takeDispatchableCommands(runId, agents[0]);
        await executeSegment(service, ports.sender, senderTrailing);
        const senderCompleted = service.snapshotForPersistence({ commands: 1, results: 1 });
        assert(senderCompleted.runs[0].results.some((result) => result.commandId === senderRoot), 'real sender root survives until receiver assessment');
        const senderValue = senderCompleted.runs[0].results.find((entry) => entry.commandId === senderRoot)?.result?.value;
        assert(isJsonRecordValue(senderValue) && Array.isArray(senderValue.results));
        assertEquals(
            senderValue.results.map((entry) => isJsonRecordValue(entry) ? entry.commandId : undefined),
            manifest.recipes.find((entry) => entry.role === 'sender')!.recipe!.commands.map((command) => command.commandId),
            'logical aggregation preserves every actual authored child identity'
        );
        service = createRallarBlackBoxControlService(input);
        service.restoreSnapshot(senderCompleted);
        register();
        const [receiverTrailing] = service.takeDispatchableCommands(runId, agents[1]);
        await executeSegment(service, ports.receiver, receiverTrailing);
        const completed = service.snapshotDistributedRun(manifest.distributedRunId);
        assertEquals(completed?.state, replacesDocument ? 'passed' : 'failed', JSON.stringify(completed?.rollup));
        if (!replacesDocument) {
            assert(
                completed?.rollup.failures.some((failure) => failure.error?.code === 'RALLAR_BB_ALM_IDENTITY_FAILED'),
                'the actual hosted rollup must reject unchanged document facts despite successful command results'
            );
        }
        assertEquals(
            ports.messages.filter((message) => isJsonRecordValue(message.command.payload) && message.command.payload.marker === 'delivery-reload').length,
            3,
            'restored suffixes and roots never resend an original'
        );
        assertEquals(
            service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0].results.length,
            1,
            'terminal evidence returns to the configured finite bounds'
        );
    });
}

for (const carrier of ALM_CONFORMANCE_CARRIERS) {
    Deno.test(`the ${carrier} takeover's three recipes run end to end against the fixture's takeover model`, async () => {
        const scenario = createAlmConformanceRecipes({
            group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
            carrier,
            typeId: 'alm.conformance',
            senderConnection: 'almConformanceSender',
            receiverConnection: 'almConformanceReceiver',
            deadlineMs: 18_000
        }).find((candidate) => candidate.scenarioId === 'durable-takeover');
        assert(scenario?.successor);
        const ports = new AlmReloadPorts(true);

        const owner = await ports.sender.execute(toRecipeRun(scenario.sender));
        const held = ports.messages.filter((message) => isJsonRecordValue(message.command.payload) && message.command.payload.marker === 'durable-takeover');
        assertEquals(held.map((message) => message.submitted), [false], 'the owner\'s hold keeps its original from the carrier');
        ports.replaceSenderDocument();
        const successor = await ports.sender.execute(toRecipeRun(scenario.successor));
        const receiver = await ports.receiver.execute(toRecipeRun(scenario.receiver));

        for (const [role, result] of [['owner', owner], ['successor', successor], ['receiver', receiver]] as const) {
            assertEquals(result.ok, true, `${role}: ${JSON.stringify(result)}`);
        }
        assertEquals(held.map((message) => message.submitted), [true], 'the successor sends the original once');
        assertEquals(
            held.map((message) => [message.carrierFallback?.to, message.attemptCarriers.includes('ws')]),
            [carrier === 'rtc-with-ws-fallback' ? ['ws', true] : [undefined, false]],
            'only the fallback owner waits for its hand-over and the WS attempt that follows it'
        );
    });
}

Deno.test('the rtc-with-ws-fallback owner fails while its held RTC leg never hands over to WS', async () => {
    const scenario = createAlmConformanceRecipes({
        group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
        carrier: 'rtc-with-ws-fallback',
        typeId: 'alm.conformance',
        senderConnection: 'almConformanceSender',
        receiverConnection: 'almConformanceReceiver',
        deadlineMs: 18_000
    }).find((candidate) => candidate.scenarioId === 'durable-takeover');
    assert(scenario);
    const ports = new AlmReloadPorts(true);
    ports.handsOverHeldFallback = false;

    const owner = await ports.sender.execute(toRecipeRun(scenario.sender));

    assertEquals(owner.ok, false, JSON.stringify(owner));
});

function toCatalogInput(carrier: AlmConformanceCarrier): CreateAlmConformanceRecipesInput {
    return {
        group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
        carrier,
        typeId: 'alm.conformance',
        senderConnection: 'almConformanceSender',
        receiverConnection: 'almConformanceReceiver',
        deadlineMs: 18_000
    };
}

function findCatalogScenario(input: CreateAlmConformanceRecipesInput, scenarioId: string): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(input).find((candidate) => candidate.scenarioId === scenarioId);
    assert(scenario, `${scenarioId} over ${input.carrier}`);
    return scenario;
}

/** The recipe's commands from the one after `after` up to and including `through`; undefined ends at the last. */
function toSegment(recipe: RallarBlackBoxTestRecipe, after: string | undefined, through: string | undefined): RallarBlackBoxTestRecipe {
    const ids = recipe.commands.map((command) => command.commandId);
    const start = after === undefined ? 0 : ids.indexOf(after) + 1;
    const end = through === undefined ? ids.length : ids.indexOf(through) + 1;
    return { ...recipe, recipeId: `${recipe.recipeId}:${start}`, commands: recipe.commands.slice(start, end) };
}

function findMarked(ports: AlmReloadPorts, marker: string): readonly PortMessage[] {
    return ports.messages.filter((message) => isJsonRecordValue(message.command.payload) && message.command.payload.marker === marker);
}

for (const carrier of ALM_CONFORMANCE_CARRIERS) {
    Deno.test(`the ${carrier} checkpoint-recovery pair restores the interval's checkpoint across the reload`, async () => {
        const { sender, receiver } = findCatalogScenario(toCatalogInput(carrier), 'checkpoint-recovery');
        const [checkpoint] = toAlmReloadCheckpoints(sender.metadata?.almReloadCheckpoints) ?? [];
        assert(checkpoint);
        const ports = new AlmReloadPorts(true);

        const results = [
            await ports.receiver.execute(toRecipeRun(toSegment(receiver, undefined, checkpoint.receiverReadyEnd))),
            await ports.sender.execute(toRecipeRun(toSegment(sender, undefined, checkpoint.senderPrefixEnd))),
            await ports.receiver.execute(toRecipeRun(toSegment(receiver, checkpoint.receiverReadyEnd, checkpoint.receiverAbsenceEnd)))
        ];
        ports.replaceSenderDocument();
        results.push(
            await ports.sender.execute(toRecipeRun(toSegment(sender, checkpoint.senderReload, undefined))),
            await ports.receiver.execute(toRecipeRun(toSegment(receiver, checkpoint.receiverAbsenceEnd, undefined)))
        );

        for (const result of results) {
            assertEquals(result.ok, true, JSON.stringify(result));
        }
        assertEquals(findMarked(ports, 'checkpoint-recovery').map((message) => message.submitted), [true], 'the restored original is sent once');
    });

    Deno.test(`the ${carrier} checkpoint-lag recipes lag, refuse, recover and deliver the admitted sends`, async () => {
        const { sender, receiver } = findCatalogScenario(toCatalogInput(carrier), 'checkpoint-lag');
        const ports = new AlmReloadPorts(true);

        const owner = await ports.sender.execute(toRecipeRun(sender));
        const received = await ports.receiver.execute(toRecipeRun(receiver));

        assertEquals(owner.ok, true, JSON.stringify(owner));
        assertEquals(received.ok, true, JSON.stringify(received));
        assertEquals(
            findMarked(ports, 'checkpoint-lag').map((message) => [message.state, message.failure]),
            [['acknowledged', undefined], ['failed', { kind: 'storage-unavailable', cause: 'checkpoint-lag' }], ['acknowledged', undefined]]
        );
    });
}

for (const carrier of ['ws', 'rtc'] as const) {
    Deno.test(`the ${carrier} flush-on-hide successor restores what the owner's lifecycle flush saved`, async () => {
        const { sender, receiver, successor } = findCatalogScenario(toCatalogInput(carrier), 'flush-on-hide');
        assert(successor);
        const ports = new AlmReloadPorts(true);

        const owner = await ports.sender.execute(toRecipeRun(sender));
        ports.flushCheckpoints();
        ports.replaceSenderDocument();
        const restored = await ports.sender.execute(toRecipeRun(successor));
        const received = await ports.receiver.execute(toRecipeRun(receiver));

        for (const [role, result] of [['owner', owner], ['successor', restored], ['receiver', received]] as const) {
            assertEquals(result.ok, true, `${role}: ${JSON.stringify(result)}`);
        }
        assertEquals(findMarked(ports, 'flush-on-hide').map((message) => message.submitted), [true]);
    });

    Deno.test(`the ${carrier} flush-on-hide successor restores nothing when the owner's page ends unflushed inside the interval`, async () => {
        const { sender, successor } = findCatalogScenario(toCatalogInput(carrier), 'flush-on-hide');
        assert(successor);
        const ports = new AlmReloadPorts(true);

        await ports.sender.execute(toRecipeRun(sender));
        ports.replaceSenderDocument();
        const restored = await ports.sender.execute(toRecipeRun(successor));

        assertEquals(restored.ok, false, JSON.stringify(restored));
        assertEquals(findMarked(ports, 'flush-on-hide').map((message) => message.submitted), [false], 'the unsaved admission is lost with its page');
    });
}

for (const carrier of ALM_CONFORMANCE_SINGLE_HOP_CARRIERS) {
    Deno.test(`the ${carrier} ordering-gap-repair pair holds the second frame, reads the range NACK and delivers all three in order`, async () => {
        const { sender, receiver } = findCatalogScenario(toCatalogInput(carrier), 'ordering-gap-repair');
        const ports = new AlmReloadPorts(true);

        const sent = await ports.sender.execute(toRecipeRun(sender));
        const received = await ports.receiver.execute(toRecipeRun(receiver));

        assertEquals(sent.ok, true, JSON.stringify(sent));
        assertEquals(received.ok, true, JSON.stringify(received));
        const messages = findMarked(ports, 'ordering-gap-repair');
        assertEquals(messages.map((message) => [message.command.seq, message.buffered, message.failure]), [
            [1, false, undefined],
            [2, false, undefined],
            [3, false, undefined]
        ]);
        assertEquals(
            [...messages].sort((left, right) => left.deliveredIndex! - right.deliveredIndex!).map((message) => message.command.seq),
            [1, 2, 3],
            'the channel read the sequences in order once the gap closed'
        );
        assertEquals(messages[1].repairAttempts, 1, 'the one gap report spent one retransmit');
    });
}

for (const carrier of ALM_CONFORMANCE_CARRIERS) {
    Deno.test(`the ${carrier} repair-exhausted pair keeps the hold, spends the budget and reads the second send skipped`, async () => {
        const { sender, receiver } = findCatalogScenario(toCatalogInput(carrier), 'repair-exhausted');
        const ports = new AlmReloadPorts(true);

        const sent = await ports.sender.execute(toRecipeRun(sender));
        const received = await ports.receiver.execute(toRecipeRun(receiver));

        assertEquals(sent.ok, true, JSON.stringify(sent));
        assertEquals(received.ok, true, JSON.stringify(received));
        assertEquals(findMarked(ports, 'repair-exhausted').map((message) => [message.command.seq, message.state, message.buffered, message.failure]), [
            [1, 'acknowledged', false, undefined],
            [2, 'failed', false, { kind: 'skipped', reason: 'repair-exhausted' }],
            [3, 'transport-accepted', true, undefined],
            [4, 'transport-accepted', true, undefined]
        ]);
    });
}

for (const carrier of ['rtc', 'rtc-with-ws-fallback'] as const) {
    // The receiver connects before the sender starts, as the sender's readiness wait orders the lane.
    Deno.test(`the ${carrier} ordering-resync receiver with a recording owner reads the owner's invocation and its cursor`, async () => {
        const { sender, receiver } = findCatalogScenario({ ...toCatalogInput(carrier), recoveryOwner: 'record' }, 'ordering-resync');
        const connectId = `${receiver.recipeId}-connect`;
        const ports = new AlmReloadPorts(true);

        const connected = await ports.receiver.execute(toRecipeRun(toSegment(receiver, undefined, connectId)));
        const sent = await ports.sender.execute(toRecipeRun(sender));
        const received = await ports.receiver.execute(toRecipeRun(toSegment(receiver, connectId, undefined)));

        for (const [role, result] of [['receiver connect', connected], ['sender', sent], ['receiver', received]] as const) {
            assertEquals(result.ok, true, `${role}: ${JSON.stringify(result)}`);
        }
        assertEquals(ports.recoveryOwnerInstalled, true);
    });
}

for (const carrier of ALM_CONFORMANCE_SINGLE_HOP_CARRIERS) {
    Deno.test(`the ${carrier} fenced-delivery trio delivers the member's send stamped with the group's roster`, async () => {
        const { sender, receiver, recipientB } = findCatalogScenario(toCatalogInput(carrier), 'fenced-delivery');
        assert(recipientB);
        const ports = new AlmReloadPorts(true);

        const results = [
            await ports.sender.execute(toRecipeRun(sender)),
            await ports.receiver.execute(toRecipeRun(receiver)),
            await ports.recipientB.execute(toRecipeRun(recipientB))
        ];

        for (const result of results) {
            assertEquals(result.ok, true, JSON.stringify(result));
        }
        assertEquals(findMarked(ports, 'fenced-delivery').map((message) => [message.submitted, message.rosterVersion]), [[true, 4]]);
    });

    // The sender runs before recipient-b, which leaves on the cue; the receiver reads what followed.
    Deno.test(`the ${carrier} fenced-catch-up trio delivers the floored send once recipient-b's leave moves the roster`, async () => {
        const { sender, receiver, recipientB } = findCatalogScenario(toCatalogInput(carrier), 'fenced-catch-up');
        assert(recipientB);
        const ports = new AlmReloadPorts(true);

        const results = [
            await ports.sender.execute(toRecipeRun(sender)),
            await ports.recipientB.execute(toRecipeRun(recipientB)),
            await ports.receiver.execute(toRecipeRun(receiver))
        ];

        for (const result of results) {
            assertEquals(result.ok, true, JSON.stringify(result));
        }
        assertEquals([ports.group.snapshotVersion, ports.group.rosterVersion, [...ports.group.left]], [8, 5, ['recipient-b']]);
        assertEquals(
            findMarked(ports, 'fenced-catch-up').map((message) => [message.floor, message.submitted]),
            [[8, true], [undefined, true]],
            'the floored send waited for the move, the cue did not'
        );
    });

    Deno.test(`the ${carrier} fenced-catch-up receiver fails while no roster move lifts the floor`, async () => {
        const { sender, receiver } = findCatalogScenario(toCatalogInput(carrier), 'fenced-catch-up');
        const ports = new AlmReloadPorts(true);
        const floored = `${receiver.recipeId}-received-floored`;
        // The arrival never comes, so the wait is shortened to keep the absence of a delivery cheap to prove.
        const shortened = {
            ...receiver,
            commands: receiver.commands.map((command) => command.commandId === floored ? { ...command, timeoutMs: 50 } : command)
        };

        await ports.sender.execute(toRecipeRun(sender));
        const received = await ports.receiver.execute(toRecipeRun(shortened));

        assertEquals(received.ok, false, JSON.stringify(received));
        assertEquals(findMarked(ports, 'fenced-catch-up').map((message) => message.submitted), [false, true]);
    });
    Deno.test(`the ${carrier} fenced-catch-up trio fails when recipient-b owns the group, whose only owner cannot leave`, async () => {
        const { sender, receiver, recipientB } = findCatalogScenario(toCatalogInput(carrier), 'fenced-catch-up');
        assert(recipientB);
        const ports = new AlmReloadPorts(true);
        ports.group.owner = 'recipient-b';
        const floored = `${receiver.recipeId}-received-floored`;
        // The arrival never comes, so the wait is shortened to keep the absence of a delivery cheap to prove.
        const shortened = {
            ...receiver,
            commands: receiver.commands.map((command) => command.commandId === floored ? { ...command, timeoutMs: 50 } : command)
        };

        await ports.sender.execute(toRecipeRun(sender));
        const mover = await ports.recipientB.execute(toRecipeRun(recipientB));
        const received = await ports.receiver.execute(toRecipeRun(shortened));

        assertEquals(mover.ok, false, JSON.stringify(mover));
        assertEquals(received.ok, false, JSON.stringify(received));
        assertEquals([ports.group.snapshotVersion, ports.group.rosterVersion, [...ports.group.left]], [7, 4, []]);
    });
}

Deno.test('the ws fenced-rejection trio reads the trusted server\'s membership-fenced rejection and delivers nothing', async () => {
    const { sender, receiver, recipientB } = findCatalogScenario(toCatalogInput('ws'), 'fenced-rejection');
    assert(recipientB);
    const ports = new AlmReloadPorts(true);

    const results = [
        await ports.sender.execute(toRecipeRun(sender)),
        await ports.receiver.execute(toRecipeRun(receiver)),
        await ports.recipientB.execute(toRecipeRun(recipientB))
    ];

    for (const result of results) {
        assertEquals(result.ok, true, JSON.stringify(result));
    }
    assertEquals(
        findMarked(ports, 'fenced-rejection').map((message) => [message.state, message.submitted, message.relayRejection]),
        [['rejected', false, { relay: 'trusted-server', reason: 'membership-fenced' }]]
    );
});

function toRecipeRun(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestCommand {
    return { kind: 'recipe.run', commandId: `${recipe.recipeId}-run`, recipe };
}

async function executeSegment(service: RallarBlackBoxControlService, runtime: RallarBlackBoxTestRuntime, envelope: ControlCommandEnvelope): Promise<void> {
    assert(envelope, 'expected an actual control dispatch');
    const result = await runtime.execute({ ...envelope.command, deadlineEpochMs: envelope.deadlineEpochMs });
    assertEquals(result.ok, true, JSON.stringify(result));
    recordResult(service, envelope, result);
}

function recordResult(service: RallarBlackBoxControlService, envelope: ControlCommandEnvelope, result: RallarBlackBoxTestResult): void {
    assertEquals(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: envelope.runId,
            agentId: envelope.agentId!,
            commandId: envelope.commandId,
            ok: result.ok,
            result
        }).accepted,
        true
    );
}
