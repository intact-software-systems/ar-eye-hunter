import { assert, assertEquals } from '@std/assert';

import {
    decodeControlBarrierEnvelope,
    RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC,
    toBarrierResolvedEvent,
    type ControlBarrierResolution
} from '@shared-test/rallar-bb-test/barrier/control-barrier-protocol.ts';
import {
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    toControlEventEnvelope,
    type ControlEventEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

import { createAlmConformance3AgentEntry } from '../../rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';
import { ControlAgentSockets } from '../src/control-agent-sockets.ts';
import { createRallarBlackBoxControlService, type RallarBlackBoxControlService } from '../src/control-service.ts';
import {
    assertRight,
    toCommandResultEnvelope,
    toControlServiceInput,
    toDistributedManifest,
    toFleetIdentity,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

interface BarrierClock {
    now: number;
}

interface ArrivalInput {
    readonly agentId: string;
    readonly runId?: string;
    readonly barrierId?: string;
    readonly timeoutMs?: number;
    readonly participants?: readonly string[];
}

const BARRIER_ID = 'alm-ws-delivery-baseline-armed';

/** The event an agent control client forwards when its runtime reaches a barrier. */
function toArrival(input: ArrivalInput): ControlEventEnvelope {
    const barrierId = input.barrierId ?? BARRIER_ID;
    const commandId = `${barrierId}-${input.agentId}`;
    return {
        kind: 'event',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: input.runId ?? 'run-1',
        agentId: input.agentId,
        atEpochMs: 1_000,
        eventId: commandId,
        commandId,
        payload: {
            eventId: commandId,
            kind: 'event',
            topic: RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC,
            atEpochMs: 1_000,
            commandId,
            severity: 'info',
            payload: {
                barrierId,
                timeoutMs: input.timeoutMs ?? 5_000,
                ...(input.participants === undefined ? {} : { participants: input.participants })
            }
        }
    };
}

function acknowledgeDispatched(service: RallarBlackBoxControlService, runId: string, agentIds: readonly string[]): void {
    for (const agentId of agentIds) {
        for (const command of service.takeDispatchableCommands(runId, agentId)) {
            service.receiveClientEnvelope(toCommandResultEnvelope({ runId, agentId, command, ok: true }));
        }
    }
}

/** Two selected agents, staged, acknowledged and started: the barrier reads its participants from the start links. */
function toRunningTwoAgentRun(clock: BarrierClock): RallarBlackBoxControlService {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => clock.now }));
    for (const agentId of ['agent-1', 'agent-2']) {
        service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId }));
    }
    assertRight(service.createDistributedRun(toDistributedManifest()));
    assertRight(service.stageDistributedRun('dist-1'));
    acknowledgeDispatched(service, 'run-1', ['agent-1', 'agent-2']);
    assertRight(service.startDistributedRun('dist-1'));
    return service;
}

function toResolutions(service: RallarBlackBoxControlService, runId: string, agentId: string) {
    return service.takeBarrierResolutions(runId, agentId).map((envelope) => envelope.resolution);
}

/** Stands in for the control socket: forwards each arrival, then hands every agent the resolutions due to it. */
function bridgeBarrierEvents(
    service: RallarBlackBoxControlService,
    agents: readonly Readonly<{ agentId: string; runtime: RallarBlackBoxTestRuntime; }>[]
): () => void {
    const forwarded = new Set<string>();
    const deliver = (): void => {
        for (const { agentId, runtime } of agents) {
            for (const envelope of service.takeBarrierResolutions('run-1', agentId)) {
                runtime.recordEvent(toBarrierResolvedEvent(envelope));
            }
        }
    };
    const unsubscribes = agents.map(({ agentId, runtime }) =>
        runtime.subscribe((state) => {
            for (const event of state.events) {
                const key = `${agentId}:${event.eventId}`;
                if (event.topic === RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC && !forwarded.has(key)) {
                    forwarded.add(key);
                    service.receiveClientEnvelope(toControlEventEnvelope(event, 'run-1', agentId));
                    deliver();
                }
            }
        })
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
}

Deno.test('a recipe barrier releases every started agent once each arrived, once per connection', () => {
    const service = toRunningTwoAgentRun({ now: 10_000 });
    service.receiveClientEnvelope(toArrival({ agentId: 'agent-1' }));
    assertEquals(toResolutions(service, 'run-1', 'agent-1'), []);

    service.receiveClientEnvelope(toArrival({ agentId: 'agent-2' }));
    const released: ControlBarrierResolution = { outcome: 'released', arrivedAgentIds: ['agent-1', 'agent-2'] };
    assertEquals(toResolutions(service, 'run-1', 'agent-1'), [released]);
    assertEquals(toResolutions(service, 'run-1', 'agent-2'), [released]);
    assertEquals(toResolutions(service, 'run-1', 'agent-1'), [], 'heard once on one connection');

    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1' }));
    assertEquals(toResolutions(service, 'run-1', 'agent-1'), [released], 'a new connection hears it again');
});

Deno.test('a recipe barrier fails timed-out for the arrived agents, and a late participant hears the same verdict', () => {
    const clock = { now: 10_000 };
    const service = toRunningTwoAgentRun(clock);
    service.receiveClientEnvelope(toArrival({ agentId: 'agent-1', timeoutMs: 5_000 }));
    clock.now = 14_999;
    assertEquals(toResolutions(service, 'run-1', 'agent-1'), []);

    clock.now = 15_000;
    const failed: ControlBarrierResolution = { outcome: 'failed', reason: 'timed-out', arrivedAgentIds: ['agent-1'], missingAgentIds: ['agent-2'] };
    assertEquals(toResolutions(service, 'run-1', 'agent-1'), [failed]);
    service.receiveClientEnvelope(toArrival({ agentId: 'agent-2', timeoutMs: 5_000 }));
    assertEquals(toResolutions(service, 'run-1', 'agent-2'), [failed]);
});

Deno.test('a recipe barrier fails at once when a participant that has not arrived failed its run', () => {
    const service = toRunningTwoAgentRun({ now: 10_000 });
    service.receiveClientEnvelope(toArrival({ agentId: 'agent-1' }));
    const [start] = service.takeDispatchableCommands('run-1', 'agent-2');
    assert(start?.command.kind === 'recipe.run');
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: start, ok: false }));

    assertEquals(toResolutions(service, 'run-1', 'agent-1'), [
        { outcome: 'failed', reason: 'participant-failed', arrivedAgentIds: ['agent-1'], missingAgentIds: ['agent-2'] }
    ]);
});

Deno.test('an outsider at the barrier, or arrivals that disagree, fail it for everyone who arrived', () => {
    const outsider = toRunningTwoAgentRun({ now: 10_000 });
    outsider.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-3' }));
    outsider.receiveClientEnvelope(toArrival({ agentId: 'agent-1' }));
    outsider.receiveClientEnvelope(toArrival({ agentId: 'agent-3' }));
    const notParticipant: ControlBarrierResolution = {
        outcome: 'failed',
        reason: 'not-a-participant',
        arrivedAgentIds: ['agent-1', 'agent-3'],
        missingAgentIds: ['agent-2']
    };
    assertEquals(toResolutions(outsider, 'run-1', 'agent-1'), [notParticipant]);
    assertEquals(toResolutions(outsider, 'run-1', 'agent-3'), [notParticipant]);

    const conflicting = toRunningTwoAgentRun({ now: 10_000 });
    conflicting.receiveClientEnvelope(toArrival({ agentId: 'agent-1', timeoutMs: 5_000 }));
    conflicting.receiveClientEnvelope(toArrival({ agentId: 'agent-2', timeoutMs: 6_000 }));
    assertEquals(toResolutions(conflicting, 'run-1', 'agent-2'), [
        { outcome: 'failed', reason: 'conflicting-arrival', arrivedAgentIds: ['agent-1', 'agent-2'], missingAgentIds: [] }
    ]);
});

Deno.test('an outsider or a disagreeing arrival after the verdict fails typed on its own, never passes', () => {
    const released = toRunningTwoAgentRun({ now: 10_000 });
    released.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-3' }));
    released.receiveClientEnvelope(toArrival({ agentId: 'agent-1' }));
    released.receiveClientEnvelope(toArrival({ agentId: 'agent-2' }));
    assertEquals(toResolutions(released, 'run-1', 'agent-1'), [
        { outcome: 'released', arrivedAgentIds: ['agent-1', 'agent-2'] }
    ]);

    released.receiveClientEnvelope(toArrival({ agentId: 'agent-3' }));
    assertEquals(toResolutions(released, 'run-1', 'agent-3'), [
        {
            outcome: 'failed',
            reason: 'not-a-participant',
            arrivedAgentIds: ['agent-1', 'agent-2', 'agent-3'],
            missingAgentIds: []
        }
    ]);
    assertEquals(toResolutions(released, 'run-1', 'agent-1'), [], 'the participants keep their released verdict');

    const clock = { now: 10_000 };
    const timedOut = toRunningTwoAgentRun(clock);
    timedOut.receiveClientEnvelope(toArrival({ agentId: 'agent-1', timeoutMs: 5_000 }));
    clock.now = 15_000;
    assertEquals(toResolutions(timedOut, 'run-1', 'agent-1').map((resolution) => resolution.outcome), ['failed']);
    timedOut.receiveClientEnvelope(toArrival({ agentId: 'agent-2', timeoutMs: 6_000 }));
    assertEquals(toResolutions(timedOut, 'run-1', 'agent-2'), [
        { outcome: 'failed', reason: 'conflicting-arrival', arrivedAgentIds: ['agent-1', 'agent-2'], missingAgentIds: [] }
    ]);
});

Deno.test('two barriers open at once resolve independently', () => {
    const service = toRunningTwoAgentRun({ now: 10_000 });
    const armed = 'alm-ws-delivery-baseline-armed';
    const nextStart = 'alm-ws-delivery-reload-start';
    service.receiveClientEnvelope(toArrival({ agentId: 'agent-1', barrierId: armed }));
    service.receiveClientEnvelope(toArrival({ agentId: 'agent-2', barrierId: nextStart }));
    assertEquals(toResolutions(service, 'run-1', 'agent-1'), []);
    assertEquals(toResolutions(service, 'run-1', 'agent-2'), []);

    service.receiveClientEnvelope(toArrival({ agentId: 'agent-2', barrierId: armed }));
    const takeIds = (agentId: string) => service.takeBarrierResolutions('run-1', agentId).map((envelope) => [envelope.barrierId, envelope.resolution.outcome]);
    assertEquals(takeIds('agent-1'), [[armed, 'released']]);
    assertEquals(takeIds('agent-2'), [[armed, 'released']], 'the other barrier stays open');

    service.receiveClientEnvelope(toArrival({ agentId: 'agent-1', barrierId: nextStart }));
    assertEquals(takeIds('agent-1'), [[nextStart, 'released']]);
    assertEquals(takeIds('agent-2'), [[nextStart, 'released']]);
});

Deno.test('a recipe barrier outside a started distributed run fails at once', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 10_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-9', agentId: 'agent-1' }));
    service.receiveClientEnvelope(toArrival({ runId: 'run-9', agentId: 'agent-1' }));

    assertEquals(toResolutions(service, 'run-9', 'agent-1'), [
        { outcome: 'failed', reason: 'no-distributed-run', arrivedAgentIds: ['agent-1'], missingAgentIds: [] }
    ]);
});

Deno.test('named participant roles resolve through the start links of the distributed run', () => {
    const manifest: RallarBlackBoxDistributedRunManifest = createAlmConformance3AgentEntry().manifest;
    const runId = manifest.controlRunId;
    const agents = ['controller-01', 'controller-02', 'controller-03'];
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 10_000 }));
    agents.forEach((agentId) =>
        service.receiveClientEnvelope(
            toRegisterEnvelope({ runId, agentId, identity: toFleetIdentity(agentId, manifest.group) })
        )
    );
    assertRight(service.createDistributedRun(manifest));
    assertRight(service.stageDistributedRun(manifest.distributedRunId));
    acknowledgeDispatched(service, runId, agents);
    acknowledgeDispatched(service, runId, agents);
    const started = assertRight(service.startDistributedRun(manifest.distributedRunId));
    const agentOf = (role: string): string => started.commandLinks.find((link) => link.phase === 'start' && link.role === role)!.agentId;
    const participants = ['sender', 'recipient-b'];

    service.receiveClientEnvelope(toArrival({ runId, agentId: agentOf('sender'), participants }));
    service.receiveClientEnvelope(toArrival({ runId, agentId: agentOf('recipient-b'), participants }));
    assertEquals(toResolutions(service, runId, agentOf('recipient-b')), [
        { outcome: 'released', arrivedAgentIds: [agentOf('sender'), agentOf('recipient-b')] }
    ]);

    service.receiveClientEnvelope(
        toArrival({ runId, agentId: agentOf('receiver'), barrierId: 'observer-armed', participants: ['observer'] })
    );
    assertEquals(toResolutions(service, runId, agentOf('receiver')), [
        { outcome: 'failed', reason: 'unknown-participant-role', arrivedAgentIds: [agentOf('receiver')], missingAgentIds: [] }
    ]);
});

Deno.test('the agent socket carries a due barrier resolution beside its commands', () => {
    const service = toRunningTwoAgentRun({ now: 10_000 });
    const sockets = new ControlAgentSockets(service);
    const sent: string[] = [];
    sockets.register(
        { readyState: 1, send: (text) => sent.push(text), close: () => undefined },
        { runId: 'run-1', agentId: 'agent-1' }
    );
    service.receiveClientEnvelope(toArrival({ agentId: 'agent-1' }));
    service.receiveClientEnvelope(toArrival({ agentId: 'agent-2' }));

    sockets.sendDispatchableCommands({ runId: 'run-1', agentId: 'agent-1' });

    const frames = sent.map((text) => decodeControlBarrierEnvelope(text, { runId: 'run-1', agentId: 'agent-1' }));
    assertEquals(frames.flatMap((frame) => frame.right === undefined ? [] : [frame.right.barrierId]), [BARRIER_ID]);
});

Deno.test('two real runtimes pass one recipe barrier through the control service', async () => {
    const service = toRunningTwoAgentRun({ now: 10_000 });
    const agents = ['agent-1', 'agent-2'].map((agentId) => ({ agentId, runtime: createDefaultRallarBlackBoxTestRuntime() }));
    const stop = bridgeBarrierEvents(service, agents);
    try {
        const results = await Promise.all(
            agents.map(({ agentId, runtime }) => runtime.execute({ kind: 'barrier', commandId: `${agentId}-armed`, barrierId: BARRIER_ID, timeoutMs: 5_000 }))
        );

        assertEquals(results.map((result) => [result.ok, result.value]), [
            [true, { barrierId: BARRIER_ID, outcome: 'released', arrivedAgentIds: ['agent-1', 'agent-2'] }],
            [true, { barrierId: BARRIER_ID, outcome: 'released', arrivedAgentIds: ['agent-1', 'agent-2'] }]
        ]);
    }
    finally {
        stop();
    }
});
