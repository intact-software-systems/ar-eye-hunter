import { assert, assertEquals } from '@std/assert';

import {
    decodeControlBarrierEnvelope,
    RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC,
    type ControlBarrierEnvelope
} from '@shared-test/rallar-bb-test/barrier/control-barrier-protocol.ts';
import {
    parseControlServerMessage,
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlClientEnvelope,
    type ControlClientIdentity,
    type ControlCommandEnvelope,
    type ControlEventEnvelope,
    type ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import type { RallarBlackBoxControlAgentIdentity } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { toAgentReloadResult } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { createManualTimers } from '../../../packages/tests/shared/resilience/manual-timers.ts';
import { createAlmConformance2AgentEntry } from '../../rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';
import { ControlAgentSockets } from '../src/control-agent-sockets.ts';
import { computeDispatchableControlCommands, toControlDispatchScan } from '../src/control-command-queue-policy.ts';
import { startControlDeadlineSweep } from '../src/control-deadline-sweep.ts';
import {
    toInitialControlAgentState,
    toInitialControlRunState,
    type ControlCommandState
} from '../src/control-service-state.ts';
import { createRallarBlackBoxControlService, type RallarBlackBoxControlService } from '../src/control-service.ts';
import { toDistributedRunRollup } from '../src/distributed/distributed-run-evaluation.ts';
import {
    isControlRecipeReloadRoot,
    toControlRecipeReloadCommands
} from '../src/recipe-reload/control-recipe-reload-commands.ts';
import { registerAgent, waitForSocketOpen } from './support/control-api-test-agent.ts';
import { getJson, startControlServer } from './support/control-api-test-server.ts';
import {
    assertRight,
    registerFleetAgents,
    toCommandResultEnvelope,
    toControlServiceInput,
    toDistributedManifest,
    toFleetIdentity,
    toRegisterEnvelope,
    toUnconfiguredAgentIdentity
} from './support/control-service-test-fixtures.ts';
import { executeControlRuntimeCommand } from './support/execute-control-runtime-command.ts';
import { takeAgentDispatchableCommands } from './support/take-agent-dispatchable-commands.ts';

const AGENTS = ['controller-01', 'controller-02'] as const;
/** A held durable send drains and probes about every 50 ms on the sender, 37 to 57 records a second. */
const HELD_SEND_DIAGNOSTICS = 2_000;
const HELD_SEND_DIAGNOSTIC_INTERVAL_MS = 20;
const SILENCE_MS = 200;

interface DispatchClock {
    now: number;
}

Deno.test('diagnostics during a held send leave the combined ALM dispatch plan exactly as it was', () => {
    const clock: DispatchClock = { now: 1_000 };
    const manifest = createAlmConformance2AgentEntry().manifest;
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => clock.now }));
    const runId = manifest.controlRunId;
    startCombinedRun(service, manifest);
    const firstSegments = AGENTS.map((agentId) => takeAgentDispatchableCommands(service, runId, agentId));
    assertEquals(firstSegments.map((segments) => segments.length), [1, 1]);
    const before = service.snapshotRun(runId)!;
    const plans = toReloadPlans(before);
    assertEquals(plans.length, 2);

    const receipts = Array.from({ length: HELD_SEND_DIAGNOSTICS }, (_, index) => {
        clock.now += HELD_SEND_DIAGNOSTIC_INTERVAL_MS;
        return service.receiveClientEnvelope(toAlmDiagnostic({ runId, agentId: AGENTS[index % 2], index, atEpochMs: clock.now }));
    });

    assertEquals(
        receipts.filter((receipt) => receipt.accepted && !receipt.affectsDispatch).length,
        HELD_SEND_DIAGNOSTICS,
        'no diagnostic asks the socket route to recompute dispatch'
    );
    const after = service.snapshotRun(runId)!;
    assertEquals(after.commands, before.commands, 'queue, dispatch and completion state are unchanged');
    assertEquals(after.results, before.results);
    assertEquals(toReloadPlans(after).map((plan) => plan.segments), plans.map((plan) => plan.segments));
    for (const [index, plan] of toReloadPlans(after).entries()) {
        assert(plan.segments === plans[index].segments, 'each root is segmented once, not per message');
    }
    assertEquals(AGENTS.map((agentId) => takeAgentDispatchableCommands(service, runId, agentId)), [[], []]);
});

Deno.test('register, result and barrier arrivals recompute dispatch; heartbeats and other events do not', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    const register = service.receiveClientEnvelope(toRegisterEnvelope());
    const queued = assertRight(service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'health-1',
        command: { kind: 'health' }
    }));
    const receipts = {
        register,
        heartbeat: service.receiveClientEnvelope(toHeartbeat('run-1', 'agent-1')),
        result: service.receiveClientEnvelope(
            toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: queued, ok: true })
        ),
        barrier: service.receiveClientEnvelope(toBarrierArrival('run-1', 'agent-1')),
        event: service.receiveClientEnvelope(toEvent('event', 'rallar.browser.closed')),
        diagnostic: service.receiveClientEnvelope(toEvent('diagnostic', 'rallar.browser.alm.outbound_diagnostics')),
        stats: service.receiveClientEnvelope(toEvent('stats', 'rallar.bb.stats')),
        report: service.receiveClientEnvelope(toEvent('report', 'rallar.bb.report.final'))
    };

    assertEquals(
        Object.fromEntries(Object.entries(receipts).map(([name, receipt]) => [name, receipt.affectsDispatch])),
        {
            register: true,
            heartbeat: false,
            result: true,
            barrier: true,
            event: false,
            diagnostic: false,
            stats: false,
            report: false
        }
    );
});

// The rollup re-evaluates every participant, so the count of evaluations per envelope is the cost being bounded.
Deno.test('one result envelope evaluates the distributed rollup once for every agent socket and every persistence flush', () => {
    const agentCount = 20;
    let evaluations = 0;
    const defaults = toControlServiceInput({ now: () => 1_000 });
    const service = createRallarBlackBoxControlService({
        ...defaults,
        dependencies: {
            ...defaults.dependencies,
            toDistributedRunRollup: (input) => {
                evaluations += 1;
                return toDistributedRunRollup(input);
            }
        }
    });
    registerFleetAgents(service, agentCount);
    const agentIds = Array.from({ length: agentCount }, (_, index) => `agent-${String(index + 1).padStart(2, '0')}`);
    const sockets = new ControlAgentSockets(service);
    const sent = new Map(agentIds.map((agentId) => [agentId, [] as ControlCommandEnvelope[]]));
    for (const agentId of agentIds) {
        sockets.register({
            readyState: 1,
            send: (text) => sent.get(agentId)!.push(JSON.parse(text)),
            close: () => undefined
        }, { runId: 'run-1', agentId });
    }
    assertRight(service.createDistributedRun(toDistributedManifest({
        targetPolicy: { mode: 'selected-agents', agentIds }
    }, { startMode: 'auto-after-ready' })));
    assertRight(service.stageDistributedRun('dist-1'));
    sockets.sendDispatchableCommandsForRun('run-1');
    const stageCommands = agentIds.map((agentId) => sent.get(agentId)!.splice(0));
    for (const [index, agentId] of agentIds.slice(0, -1).entries()) {
        acceptSocketEnvelope(service, sockets, toCommandResultEnvelope({ runId: 'run-1', agentId, command: stageCommands[index][0], ok: true }));
    }

    evaluations = 0;
    acceptSocketEnvelope(
        service,
        sockets,
        toCommandResultEnvelope({
            runId: 'run-1',
            agentId: agentIds[agentCount - 1],
            command: stageCommands[agentCount - 1][0],
            ok: true
        })
    );
    const persisted = [service.snapshotForPersistence({}), service.snapshotForPersistence({})];

    assertEquals(evaluations, 1);
    assertEquals(persisted.map((snapshot) => snapshot.distributedRuns?.[0]?.rollup.summary.passedRecipes), [0, 0]);
    assertEquals(
        agentIds.map((agentId) => sent.get(agentId)!.map((command) => command.command.kind)),
        agentIds.map(() => ['recipe.run'])
    );
    assertEquals(service.snapshotDistributedRun('dist-1')?.state, 'running');
});

Deno.test('a registration and a barrier arrival are answered on the socket at once, a diagnostic is not', async () => {
    const server = await startControlServer();
    const socket = new WebSocket(server.baseUrl.replace('http:', 'ws:') + '/control');
    try {
        const queued = await fetch(server.baseUrl + '/runs/run-1/agents/agent-1/commands', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ commandId: 'queued-before-register', command: { kind: 'health' } })
        });
        assertEquals(queued.status, 202);
        await queued.json();
        await waitForSocketOpen(socket);
        const frames = collectFrames(socket, { runId: 'run-1', agentId: 'agent-1' });
        socket.send(JSON.stringify(toRegisterEnvelope({ identity: toUnconfiguredAgentIdentity('agent-1', Date.now()) })));
        assertEquals((await frames.nextCommand()).commandId, 'queued-before-register');

        socket.send(JSON.stringify(toEvent('diagnostic', 'rallar.browser.alm.outbound_diagnostics')));
        await waitForRun(server.baseUrl, (run) => run.events.some((event) => event.kind === 'diagnostic'));
        await frames.expectSilence();

        socket.send(JSON.stringify(toBarrierArrival('run-1', 'agent-1')));
        const barrier = await frames.nextBarrier();
        assertEquals(barrier.resolution, {
            outcome: 'failed',
            reason: 'no-distributed-run',
            arrivedAgentIds: ['agent-1'],
            missingAgentIds: []
        });
    }
    finally {
        socket.close();
        await server.stop();
    }
});

Deno.test('an expired reload readiness is judged by the deadline sweep without any agent message', async () => {
    const server = await startControlServer({ RALLAR_BLACK_BOX_DEADLINE_SWEEP_INTERVAL_MS: String(SILENCE_MS / 2) });
    const socket = await registerAgent(server.baseUrl, 'run-1', 'agent-1');
    try {
        const frames = collectFrames(socket, { runId: 'run-1', agentId: 'agent-1' });
        const response = await fetch(server.baseUrl + '/runs/run-1/agents/agent-1/commands', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                commandId: 'socket-root',
                command: {
                    kind: 'recipe.run',
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'socket-reload',
                        continueOnFailure: false,
                        metadata: { profile: 'alm-conformance' },
                        commands: [
                            { kind: 'health', commandId: 'before' },
                            { kind: 'agent.reload', commandId: 'reload', readyTimeoutMs: SILENCE_MS },
                            { kind: 'health', commandId: 'after' }
                        ]
                    }
                }
            })
        });
        assertEquals(response.status, 202);
        await response.json();
        const prefix = await frames.nextCommand();
        socket.send(JSON.stringify(await executeSocketCommand(prefix)));
        const reload = await frames.nextCommand();
        assertEquals(reload.command.kind, 'agent.reload', 'a result dispatches the next segment at once');
        socket.send(JSON.stringify(await executeSocketCommand(reload)));

        // A run read judges pending reloads itself, so this test reads the persisted snapshot, which does not.
        const judged = await waitForPersistedRun(
            server.storageDir,
            (run) => run.results.some((result) => result.commandId === 'socket-root')
        );
        const root = judged.results.find((result) => result.commandId === 'socket-root')!;
        assertEquals([root.ok, root.result?.error?.code], [false, 'RALLAR_BLACK_BOX_RELOAD_READY_TIMEOUT']);
    }
    finally {
        socket.close();
        await server.stop();
    }
});

// Before the scan was built once per message, each agent's pass resolved a reload owner by scanning every command for
// every command: 50 agents and 1,000 commands read about 50 million command entries per message.
Deno.test('one dispatch scan reads each queued command a bounded number of times, however many agents it serves', () => {
    const agentCount = 50;
    const commandsPerAgent = 20;
    const run = toInitialControlRunState('run-1', 1_000);
    const reads = new Map<string, number>();
    const agents = Array.from({ length: agentCount }, (_, index) => {
        const agent = toInitialControlAgentState('run-1', `agent-${index}`);
        agent.connected = true;
        agent.connectionSequence = 1;
        run.agents.set(agent.agentId, agent);
        return agent;
    });
    for (const agent of agents) {
        for (let index = 0; index < commandsPerAgent; index += 1) {
            const command = toQueuedHealthCommand(agent.agentId, `${agent.agentId}-health-${index}`);
            run.commands.set(command.envelope.commandId, toReadCountingCommand(command, reads));
        }
    }

    const scan = toControlDispatchScan(run);
    const readsAfterScan = toTotalReads(reads);
    reads.clear();
    const firstAgent = computeDispatchableControlCommands({ scan, agent: agents[0], nowEpochMs: 1_000 });
    const firstAgentReads = new Map(reads);
    for (const agent of agents.slice(1)) {
        computeDispatchableControlCommands({ scan, agent, nowEpochMs: 1_000 });
    }

    assertEquals(firstAgent.length, commandsPerAgent);
    assertEquals([...firstAgentReads.keys()].every((commandId) => commandId.startsWith('agent-0-')), true, 'one agent reads only its own commands');
    assertEquals(firstAgentReads.size, commandsPerAgent);
    assert(readsAfterScan <= 2 * agentCount * commandsPerAgent, `${readsAfterScan} reads to build the scan`);
    assert(toTotalReads(reads) <= 4 * agentCount * commandsPerAgent, `${toTotalReads(reads)} reads to serve every agent`);
});

Deno.test('a heartbeat neither scans dispatch nor evaluates the rollup; the deadline sweep does both', async () => {
    let evaluations = 0;
    const defaults = toControlServiceInput({ now: () => 1_000 });
    const service = createRallarBlackBoxControlService({
        ...defaults,
        dependencies: {
            ...defaults.dependencies,
            toDistributedRunRollup: (input) => {
                evaluations += 1;
                return toDistributedRunRollup(input);
            }
        }
    });
    registerFleetAgents(service, 2);
    const sockets = new ControlAgentSockets(service);
    for (const agentId of ['agent-01', 'agent-02']) {
        sockets.register({ readyState: 1, send: () => undefined, close: () => undefined }, { runId: 'run-1', agentId });
    }
    assertRight(service.createDistributedRun(toDistributedManifest({
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-01', 'agent-02'] }
    })));
    const timers = createManualTimers(1_000);
    let persisted = 0;
    const stopSweep = startControlDeadlineSweep({ agentSockets: sockets, persistence: { persist: () => persisted += 1 }, timers, intervalMs: 1_000 });

    evaluations = 0;
    acceptSocketEnvelope(service, sockets, toHeartbeat('run-1', 'agent-01'));
    const afterHeartbeat = evaluations;
    await timers.advanceTo(2_000);
    stopSweep();
    await timers.advanceTo(10_000);

    assertEquals([afterHeartbeat, evaluations, persisted], [0, 1, 1]);
});

/** The socket route's order for one accepted client frame: receive, then dispatch to the run's sockets. */
function acceptSocketEnvelope(
    service: RallarBlackBoxControlService,
    sockets: ControlAgentSockets,
    envelope: ControlClientEnvelope
): void {
    if (service.receiveClientEnvelope(envelope).affectsDispatch) {
        sockets.sendDispatchableCommandsForRun(envelope.runId);
    }
}

function startCombinedRun(
    service: RallarBlackBoxControlService,
    manifest: ReturnType<typeof createAlmConformance2AgentEntry>['manifest']
): void {
    const runId = manifest.controlRunId;
    for (const agentId of AGENTS) {
        service.receiveClientEnvelope(
            toRegisterEnvelope({ runId, agentId, identity: toFleetIdentity(agentId, manifest.group) })
        );
    }
    assertRight(service.createDistributedRun(manifest));
    assertRight(service.stageDistributedRun(manifest.distributedRunId));
    for (const _phase of ['stage', 'barrier']) {
        for (const agentId of AGENTS) {
            for (const command of takeAgentDispatchableCommands(service, runId, agentId)) {
                service.receiveClientEnvelope(toCommandResultEnvelope({ runId, agentId, command, ok: true }));
            }
        }
    }
    assertRight(service.startDistributedRun(manifest.distributedRunId));
}

function toReloadPlans(
    run: ControlRunSnapshot
): readonly Readonly<{ rootId: string; segments: readonly ControlCommandEnvelope[]; }>[] {
    return run.commands.flatMap((command) =>
        isControlRecipeReloadRoot(command.envelope)
            ? [{ rootId: command.envelope.commandId, segments: toControlRecipeReloadCommands(command.envelope) }]
            : []
    );
}

interface AlmDiagnosticInput {
    readonly runId: string;
    readonly agentId: string;
    readonly index: number;
    readonly atEpochMs: number;
}

function toAlmDiagnostic({ runId, agentId, index, atEpochMs }: AlmDiagnosticInput): ControlEventEnvelope {
    return {
        ...toEvent('diagnostic', 'rallar.browser.alm.outbound_diagnostics'),
        runId,
        agentId,
        atEpochMs,
        eventId: `held-send-${index}`
    };
}

function toEvent(kind: ControlEventEnvelope['kind'], topic: string): ControlEventEnvelope {
    return {
        kind,
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_000,
        eventId: `${kind}-1`,
        payload: {
            eventId: `${kind}-1`,
            kind,
            topic,
            atEpochMs: 1_000,
            severity: 'info',
            payload: { kind: 'effect-drain', claimedCount: 1, rescheduledCount: 1 }
        }
    };
}

function toBarrierArrival(runId: string, agentId: string): ControlEventEnvelope {
    return {
        ...toEvent('event', RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC),
        runId,
        agentId,
        eventId: 'barrier-arrived',
        payload: {
            eventId: 'barrier-arrived',
            kind: 'event',
            topic: RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC,
            atEpochMs: 1_000,
            severity: 'info',
            payload: { barrierId: 'armed', timeoutMs: 5_000 }
        }
    };
}

function toHeartbeat(runId: string, agentId: string): ControlClientEnvelope {
    return {
        kind: 'heartbeat',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId,
        agentId,
        atEpochMs: Date.now(),
        status: 'running',
        identity: toAgentIdentity(agentId)
    };
}

function toAgentIdentity(agentId: string): RallarBlackBoxControlAgentIdentity {
    return toUnconfiguredAgentIdentity(agentId, Date.now());
}

async function executeSocketCommand(command: ControlCommandEnvelope): Promise<ControlResultEnvelope> {
    const result = command.command.kind === 'agent.reload'
        ? toAgentReloadResult({ commandId: command.commandId, readyTimeoutMs: command.command.readyTimeoutMs, written: 'written', atEpochMs: Date.now() })
        : await executeControlRuntimeCommand(createDefaultRallarBlackBoxTestRuntime(), command);
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: command.runId,
        agentId: command.agentId!,
        commandId: command.commandId,
        ok: result.ok,
        result
    };
}

type ServerFrame = ControlCommandEnvelope | ControlBarrierEnvelope;

interface SocketFrames {
    nextCommand(): Promise<ControlCommandEnvelope>;
    nextBarrier(): Promise<ControlBarrierEnvelope>;
    expectSilence(): Promise<void>;
}

function decodeSocketFrame(raw: string, identity: ControlClientIdentity): ServerFrame {
    const barrier = decodeControlBarrierEnvelope(raw, identity);
    if (barrier.right !== undefined) {
        return barrier.right;
    }
    const parsed = parseControlServerMessage(raw, identity);
    assert(parsed.ok, 'expected a validated command or barrier frame');
    return parsed.envelope;
}

/** Buffers every server frame, so a frame sent before a reader asks for it is never lost. */
function collectFrames(socket: WebSocket, identity: ControlClientIdentity): SocketFrames {
    const frames: ServerFrame[] = [];
    const waiters: ((frame: ServerFrame) => void)[] = [];
    socket.addEventListener('message', (event) => {
        const frame = decodeSocketFrame(String(event.data), identity);
        const waiter = waiters.shift();
        if (waiter) {
            waiter(frame);
            return;
        }
        frames.push(frame);
    });
    const next = (): Promise<ServerFrame> => {
        const buffered = frames.shift();
        return buffered !== undefined ? Promise.resolve(buffered) : new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Expected a server frame.')), 2_000);
            waiters.push((frame) => {
                clearTimeout(timeout);
                resolve(frame);
            });
        });
    };
    return {
        nextCommand: async () => {
            const frame = await next();
            assert(frame.kind === 'command', JSON.stringify(frame));
            return frame;
        },
        nextBarrier: async () => {
            const frame = await next();
            assert(frame.kind === 'barrier', JSON.stringify(frame));
            return frame;
        },
        expectSilence: async () => {
            await new Promise((resolve) => setTimeout(resolve, SILENCE_MS));
            assertEquals(frames, [], 'the server sent a frame');
        }
    };
}

function toQueuedHealthCommand(agentId: string, commandId: string): ControlCommandState {
    return {
        envelope: {
            kind: 'command',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'run-1',
            agentId,
            commandId,
            command: { kind: 'health' }
        },
        fingerprint: commandId,
        queuedAtEpochMs: 1_000,
        dispatchCount: 0
    };
}

/** Counts each read of a queued command's envelope under its command id: one read is one touched queue entry. */
function toReadCountingCommand(command: ControlCommandState, reads: Map<string, number>): ControlCommandState {
    return new Proxy(command, {
        get(target, property, receiver) {
            if (property === 'envelope') {
                reads.set(target.envelope.commandId, (reads.get(target.envelope.commandId) ?? 0) + 1);
            }
            return Reflect.get(target, property, receiver);
        }
    });
}

function toTotalReads(reads: ReadonlyMap<string, number>): number {
    return [...reads.values()].reduce((total, count) => total + count, 0);
}

async function waitForRun(
    baseUrl: string,
    satisfied: (run: ControlRunSnapshot) => boolean
): Promise<ControlRunSnapshot> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const run = await getJson<ControlRunSnapshot>(baseUrl, '/runs/run-1');
        if (satisfied(run)) {
            return run;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('The run never reached the expected state.');
}

async function waitForPersistedRun(
    storageDir: string,
    satisfied: (run: ControlRunSnapshot) => boolean
): Promise<ControlRunSnapshot> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const run = await readPersistedRun(storageDir);
        if (run !== undefined && satisfied(run)) {
            return run;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('The persisted run never reached the expected state.');
}

async function readPersistedRun(storageDir: string): Promise<ControlRunSnapshot | undefined> {
    let raw: string;
    try {
        raw = await Deno.readTextFile(`${storageDir}/control-snapshot.json`);
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return undefined;
        }
        throw toError(error);
    }
    const snapshot = decodeRecord(JSON.parse(raw)).snapshot;
    assert(isJsonRecordValue(snapshot) && Array.isArray(snapshot.runs));
    const run = snapshot.runs.find((candidate) => isJsonRecordValue(candidate) && candidate.runId === 'run-1');
    if (run === undefined) {
        return undefined;
    }
    const decoded = decodeControlRunSnapshot(run);
    assert(decoded.right !== undefined, decoded.left);
    return decoded.right;
}
