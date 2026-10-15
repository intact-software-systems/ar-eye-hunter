import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot, ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { CONTROL_RUN_COMPLETION_FILE_NAME } from '@shared-test/rallar-bb-test/control/control-run-completion.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { assert, assertEquals } from '@std/assert';

import { createManualTimers, type ManualTimers } from '../../../packages/tests/shared/resilience/manual-timers.ts';
import {
    ControlArtifactRecorder,
    DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG,
    toRunDirectoryName
} from '../src/control-artifact-recorder.ts';
import { createRallarBlackBoxControlService, type RallarBlackBoxControlService } from '../src/control-service.ts';
import { ControlSnapshotPersistence } from '../src/control-snapshot-persistence.ts';
import { createControlHttpResponses } from '../src/http/control-http-responses.ts';
import { routeDistributedRunReadRequest } from '../src/routes/distributed-run-routes-read.ts';
import { routeRunReadRequest } from '../src/routes/run-routes-read.ts';
import {
    ControlCompletedRunArchive,
    DEFAULT_CONTROL_RUN_COMPLETION_CONFIG,
    type ControlRunCompletionConfig
} from '../src/run-completion/control-run-completion.ts';
import {
    assertJsonEquals,
    assertRight,
    toCommandResultEnvelope,
    toControlServiceInput,
    toDistributedManifest,
    toFleetIdentity,
    toHeartbeatEnvelope,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';
import { takeAgentDispatchableCommands } from './support/take-agent-dispatchable-commands.ts';

const START_EPOCH_MS = 100_000;
const FLUSH_INTERVAL_MS = 500;
const EVENTS_PER_RUN = 24;
const EVENT_PADDING = 'e'.repeat(2_048);
/** Quiet long enough that a completed run's last disconnect is older than it once the clock moves on. */
const COMPLETION_CONFIG: ControlRunCompletionConfig = {
    ...DEFAULT_CONTROL_RUN_COMPLETION_CONFIG,
    quietMs: 1_000
};

interface CompletionFixture {
    readonly storageDir: string;
    readonly timers: ManualTimers;
    readonly service: RallarBlackBoxControlService;
    readonly persistence: ControlSnapshotPersistence;
    readonly archive: ControlCompletedRunArchive;
    readonly timings: RallarTimingEvent[];
    readonly persistCalls: () => number;
}

interface CompletionFixtureInput {
    readonly storageDir: string;
    readonly timers: ManualTimers;
    readonly service?: RallarBlackBoxControlService;
    readonly retentionMaxRuns?: number;
    readonly recorder?: ControlArtifactRecorder;
}

function toFixture(input: CompletionFixtureInput): CompletionFixture {
    const timers = input.timers;
    const service = input.service ?? createRallarBlackBoxControlService(toControlServiceInput({ now: () => timers.nowMs() }));
    const timings: RallarTimingEvent[] = [];
    let persistCalls = 0;
    const persistence = new ControlSnapshotPersistence({
        storageDir: input.storageDir,
        retentionMaxRuns: input.retentionMaxRuns ?? 0,
        snapshotBounds: {},
        flushIntervalMs: FLUSH_INTERVAL_MS,
        controlService: service,
        deleteRuns: (runIds) => runIds.forEach((runId) => input.recorder?.deleteRun(runId)),
        timers,
        timingSink: (event) => timings.push(event)
    });
    const archive = new ControlCompletedRunArchive({
        storageDir: input.storageDir,
        controlService: service,
        persistence: {
            persist: () => {
                persistCalls += 1;
                persistence.persist();
            }
        },
        timers,
        timingSink: (event) => timings.push(event),
        config: COMPLETION_CONFIG
    });
    return { storageDir: input.storageDir, timers, service, persistence, archive, timings, persistCalls: () => persistCalls };
}

interface RunFixtureInput {
    readonly runId: string;
    readonly agentIds: readonly string[];
    /** A completed run passed its distributed run and every agent left; an active one keeps its agents connected. */
    readonly completed: boolean;
}

function toDistributedRunId(runId: string): string {
    return `dist-${runId}`;
}

/** A run whose distributed run passed and whose agents reported events; completed runs have no agent connected. */
function createRun(service: RallarBlackBoxControlService, { runId, agentIds, completed }: RunFixtureInput): void {
    for (const agentId of agentIds) {
        service.receiveClientEnvelope(toRegisterEnvelope({ runId, agentId, identity: toFleetIdentity(agentId) }));
    }
    assertRight(service.createDistributedRun(toDistributedManifest({
        distributedRunId: toDistributedRunId(runId),
        controlRunId: runId,
        targetPolicy: { mode: 'selected-agents', agentIds: [...agentIds] }
    })));
    assertRight(service.stageDistributedRun(toDistributedRunId(runId)));
    for (const agentId of agentIds) {
        const [stage] = takeAgentDispatchableCommands(service, runId, agentId);
        service.receiveClientEnvelope(toCommandResultEnvelope({ runId, agentId, command: stage, ok: true }));
    }
    assertRight(service.startDistributedRun(toDistributedRunId(runId)));
    for (const agentId of agentIds) {
        const [start] = takeAgentDispatchableCommands(service, runId, agentId);
        service.receiveClientEnvelope(toCommandResultEnvelope({ runId, agentId, command: start, ok: true }));
    }
    for (let index = 0; index < EVENTS_PER_RUN; index += 1) {
        service.receiveClientEnvelope({
            kind: 'event',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId,
            agentId: agentIds[index % agentIds.length],
            atEpochMs: START_EPOCH_MS + index,
            eventId: `${runId}-event-${index}`,
            payload: { topic: 'rallar.bb.test', index, padding: EVENT_PADDING }
        });
    }
    assertEquals(service.snapshotDistributedRun(toDistributedRunId(runId))?.state, 'passed');
    if (completed) {
        agentIds.forEach((agentId) => service.markAgentDisconnected(runId, agentId));
    }
}

function createRuns(service: RallarBlackBoxControlService, completedCount: number, activeCount: number): void {
    for (let index = 1; index <= completedCount; index += 1) {
        createRun(service, { runId: `done-${index}`, agentIds: ['agent-1', 'agent-2'], completed: true });
    }
    for (let index = 1; index <= activeCount; index += 1) {
        createRun(service, { runId: `live-${index}`, agentIds: ['agent-1', 'agent-2'], completed: false });
    }
}

async function readPersistedSnapshot(storageDir: string): Promise<ControlServerSnapshot> {
    return JSON.parse(await Deno.readTextFile(`${storageDir}/control-snapshot.json`)).snapshot;
}

async function flush(fixture: CompletionFixture): Promise<string> {
    fixture.persistence.persist();
    await fixture.timers.advance(FLUSH_INTERVAL_MS * 2);
    return await Deno.readTextFile(`${fixture.storageDir}/control-snapshot.json`);
}

function toCompletionFilePath(storageDir: string, runId: string): string {
    return `${storageDir}/runs/${toRunDirectoryName(runId)}/${CONTROL_RUN_COMPLETION_FILE_NAME}`;
}

async function withStorageDir(prefix: string, run: (storageDir: string) => Promise<void>): Promise<void> {
    const storageDir = await Deno.makeTempDir({ prefix: `rallar-control-completion-${prefix}-` });
    try {
        await run(storageDir);
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
}

function withSilencedConsole<T>(run: () => Promise<T>): Promise<{ value: T; warnings: string[]; }> {
    const warnings: string[] = [];
    const warn = console.warn;
    const log = console.log;
    console.warn = (message: string) => warnings.push(message);
    console.log = () => undefined;
    return run().then((value) => ({ value, warnings })).finally(() => {
        console.warn = warn;
        console.log = log;
    });
}

Deno.test('the flushed snapshot carries completed runs as index entries and its revision moves only with the active run', async () => {
    await withStorageDir('index', async (storageDir) => {
        const timers = createManualTimers(START_EPOCH_MS);
        const fixture = toFixture({ storageDir, timers });
        createRuns(fixture.service, 4, 1);
        const liveText = await flush(fixture);
        await timers.advance(COMPLETION_CONFIG.quietMs);
        const completedAtEpochMs = timers.nowMs();

        const archived = await fixture.archive.completeRuns();
        const indexedText = await flush(fixture);
        const indexed = await readPersistedSnapshot(storageDir);
        const completed = indexed.runs.filter((run) => run.runId.startsWith('done-'));
        const active = indexed.runs.find((run) => run.runId === 'live-1');
        const revisionBefore = fixture.service.snapshotRevision().content;
        const refused = fixture.service.receiveClientEnvelope(
            toHeartbeatEnvelope({ runId: 'done-1', agentId: 'agent-1', atEpochMs: timers.nowMs() })
        );
        const revisionAfterRefusal = fixture.service.snapshotRevision().content;
        fixture.service.receiveClientEnvelope(toHeartbeatEnvelope({ runId: 'live-1', agentId: 'agent-1', atEpochMs: timers.nowMs() }));
        const revisionAfterActive = fixture.service.snapshotRevision().content;

        assertEquals(archived.toSorted(), ['done-1', 'done-2', 'done-3', 'done-4']);
        assertEquals(completed.length, 4);
        for (const run of completed) {
            assertEquals([run.commands, run.results, run.events, run.stats, run.reports, run.heartbeats].map((rows) => rows.length), [0, 0, 0, 0, 0, 0]);
            assertEquals(run.agents.length, 2, 'the index keeps the agents and their counters');
            assertEquals(run.completion?.counts.events, EVENTS_PER_RUN);
            assertEquals(run.completion?.counts.results, 4);
            assertEquals(run.completion?.file.path, `runs/${toRunDirectoryName(run.runId)}/${CONTROL_RUN_COMPLETION_FILE_NAME}`);
            assertEquals(run.completion?.file.state, 'present');
            assert((run.completion?.file.bytes ?? 0) > EVENTS_PER_RUN * EVENT_PADDING.length);
            assertEquals(run.completion?.completedAtEpochMs, completedAtEpochMs);
        }
        assertEquals(active?.events.length, EVENTS_PER_RUN);
        assertEquals(active?.completion, undefined);
        assert(indexedText.length * 3 < liveText.length, `${indexedText.length} bytes after, ${liveText.length} before`);
        assertEquals(refused.accepted, false, 'a completed run refuses new envelopes');
        assertEquals(revisionAfterRefusal, revisionBefore);
        assert(revisionAfterActive !== revisionBefore);
        assertEquals(fixture.persistCalls(), 1, 'the archive asks for one flush per pass that archived a run');
        const completions = fixture.timings.filter((event) => event.operation === 'run.completion');
        assertEquals(completions.length, 4);
        assert(completions.every((event) => event.status === 'ok' && ((event.details?.bytes ?? 0) as number) > 0));
        await fixture.archive.stop();
    });
});

Deno.test('restore loads the index and serves a completed run from its file, bounded like a live read', async () => {
    await withStorageDir('restore', async (storageDir) => {
        const timers = createManualTimers(START_EPOCH_MS);
        const first = toFixture({ storageDir, timers });
        createRuns(first.service, 1, 1);
        const beforeArchive = first.service.snapshotRun('done-1', {});
        await timers.advance(COMPLETION_CONFIG.quietMs);
        assertEquals(await first.archive.completeRuns(), ['done-1']);
        await first.persistence.stop();
        await first.archive.stop();

        const restored = toFixture({ storageDir, timers });
        const { warnings } = await withSilencedConsole(async () => {
            await restored.persistence.restore();
            await restored.archive.restore();
        });
        const index = restored.service.snapshotRun('done-1', {});
        const full = assertRight(await restored.archive.readRun('done-1', {}));
        const bounded = assertRight(await restored.archive.readRun('done-1', { events: 1, results: 2 }));
        const live = assertRight(await restored.archive.readRun('live-1', {}));

        assertEquals(warnings, []);
        assertEquals(index?.completion?.file.state, 'present');
        assertEquals(index?.results.length, 0);
        assertJsonEquals(full.results, beforeArchive?.results);
        assertJsonEquals(full.events, beforeArchive?.events);
        assertEquals(full.agents, index?.agents);
        assertEquals(full.completion, index?.completion, 'the served snapshot carries the index entry');
        assertEquals(bounded.events.map((event) => event.eventId), [`done-1-event-${EVENTS_PER_RUN - 1}`]);
        assertEquals(bounded.results.length, 2);
        assertEquals(live.events.length, EVENTS_PER_RUN);
        assertEquals(live.completion, undefined);
        assertEquals((await restored.archive.readRun('unknown', {})).left?.code, 'run-not-found');
        assertRight(decodeControlRunSnapshot(JSON.parse(await Deno.readTextFile(toCompletionFilePath(storageDir, 'done-1')))));
    });
});

Deno.test('a crash before the index is flushed leaves the run live in the snapshot and the next pass completes it again', async () => {
    await withStorageDir('crash', async (storageDir) => {
        const timers = createManualTimers(START_EPOCH_MS);
        const first = toFixture({ storageDir, timers });
        createRuns(first.service, 1, 0);
        const liveSnapshotText = await flush(first);
        await timers.advance(COMPLETION_CONFIG.quietMs);
        assertEquals(await first.archive.completeRuns(), ['done-1']);
        const firstFile = await Deno.stat(toCompletionFilePath(storageDir, 'done-1'));
        // The process dies after the file write and before the index flush: the snapshot on disk still holds the rows.
        await Deno.writeTextFile(`${storageDir}/control-snapshot.json`, liveSnapshotText);

        const restored = toFixture({ storageDir, timers });
        await withSilencedConsole(async () => {
            await restored.persistence.restore();
            await restored.archive.restore();
        });
        const liveAgain = assertRight(await restored.archive.readRun('done-1', {}));
        assertEquals(restored.service.snapshotRun('done-1')?.completion, undefined);
        assertEquals(liveAgain.events.length, EVENTS_PER_RUN);

        await timers.advance(1);
        assertEquals(await restored.archive.completeRuns(), ['done-1']);
        const rewritten = await Deno.stat(toCompletionFilePath(storageDir, 'done-1'));
        const fromFile = assertRight(await restored.archive.readRun('done-1', {}));
        assertJsonEquals(fromFile.events, liveAgain.events);
        assertEquals(rewritten.size, firstFile.size);
        assertEquals(restored.service.snapshotRun('done-1')?.completion?.file.state, 'present');
    });
});

Deno.test('an export during the hand-over reads the run live or from its file, never empty', async () => {
    await withStorageDir('handover', async (storageDir) => {
        const timers = createManualTimers(START_EPOCH_MS);
        const fixture = toFixture({ storageDir, timers });
        createRuns(fixture.service, 1, 0);
        await timers.advance(COMPLETION_CONFIG.quietMs);

        const pass = fixture.archive.completeRuns();
        const during = assertRight(await fixture.archive.readRun('done-1', {}));
        assertEquals(await pass, ['done-1']);
        const after = assertRight(await fixture.archive.readRun('done-1', {}));

        assertEquals(during.events.length, EVENTS_PER_RUN);
        assertJsonEquals(after.events, during.events);
        assertJsonEquals(after.results, during.results);
        assertEquals(during.completion, undefined);
        assertEquals(after.completion?.file.state, 'present');
    });
});

Deno.test('a failed file write keeps the run live and in the flush, and the write is retried after the backoff', async () => {
    await withStorageDir('write-failure', async (storageDir) => {
        const timers = createManualTimers(START_EPOCH_MS);
        const fixture = toFixture({ storageDir, timers });
        createRuns(fixture.service, 1, 0);
        await timers.advance(COMPLETION_CONFIG.quietMs);
        // A regular file where the run directories live makes every completion write fail.
        await Deno.writeTextFile(`${storageDir}/runs`, 'not a directory');

        const failed = await withSilencedConsole(() => fixture.archive.completeRuns());
        const stillLive = fixture.service.snapshotRun('done-1', {});
        const flushed = await flush(fixture);
        const skipped = await withSilencedConsole(() => fixture.archive.completeRuns());
        await Deno.remove(`${storageDir}/runs`);
        const tooEarly = await withSilencedConsole(() => fixture.archive.completeRuns());
        await timers.advance(COMPLETION_CONFIG.retryBackoff.baseMs);
        const retried = await fixture.archive.completeRuns();

        assertEquals(failed.value, []);
        assertEquals(failed.warnings.length, 1);
        assert(failed.warnings[0].includes('done-1'), failed.warnings[0]);
        assertEquals(stillLive?.completion, undefined);
        assertEquals(stillLive?.events.length, EVENTS_PER_RUN);
        assert(flushed.includes(EVENT_PADDING), 'the flush keeps the live rows');
        assertEquals(skipped.warnings, [], 'no attempt before the retry instant');
        assertEquals(tooEarly.value, []);
        assertEquals(retried, ['done-1']);
        const failure = fixture.timings.find((event) => event.operation === 'run.completion' && event.status === 'error');
        assert(failure);
        assertEquals(fixture.service.snapshotRun('done-1')?.completion?.file.state, 'present');
    });
});

Deno.test('a missing file for an indexed run is reported on its index entry while the other runs are served', async () => {
    await withStorageDir('missing', async (storageDir) => {
        const timers = createManualTimers(START_EPOCH_MS);
        const first = toFixture({ storageDir, timers });
        createRuns(first.service, 2, 0);
        await timers.advance(COMPLETION_CONFIG.quietMs);
        assertEquals((await first.archive.completeRuns()).toSorted(), ['done-1', 'done-2']);
        await first.persistence.stop();
        await Deno.remove(toCompletionFilePath(storageDir, 'done-1'));

        const restored = toFixture({ storageDir, timers });
        const { warnings } = await withSilencedConsole(async () => {
            await restored.persistence.restore();
            await restored.archive.restore();
        });
        const missing = await restored.archive.readRun('done-1', {});
        const served = assertRight(await restored.archive.readRun('done-2', {}));
        const listed = restored.service.snapshot().runs.map((run) => [run.runId, run.completion?.file.state]);

        assertEquals(warnings.length, 1);
        assert(warnings[0].includes('done-1'), warnings[0]);
        assertEquals(missing.left?.code, 'completed-run-file-missing');
        assertEquals(served.events.length, EVENTS_PER_RUN);
        assertEquals(listed, [['done-1', 'missing'], ['done-2', 'present']]);

        // A file that disappears while the server runs is reported by the read that misses it.
        await Deno.remove(toCompletionFilePath(storageDir, 'done-2'));
        const { value: lateMissing } = await withSilencedConsole(() => restored.archive.readRun('done-2', {}));
        assertEquals(lateMissing.left?.code, 'completed-run-file-missing');
        assertEquals(restored.service.snapshotRun('done-2')?.completion?.file.state, 'missing');
    });
});

Deno.test('retention beyond max runs deletes a completed run\'s file with its index entry', async () => {
    await withStorageDir('retention', async (storageDir) => {
        const timers = createManualTimers(START_EPOCH_MS);
        const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => timers.nowMs() }));
        const recorder = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: service,
            timers,
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
        });
        const fixture = toFixture({ storageDir, timers, service, retentionMaxRuns: 1, recorder });
        createRun(service, { runId: 'done-1', agentIds: ['agent-1'], completed: true });
        await timers.advance(COMPLETION_CONFIG.quietMs);
        assertEquals(await fixture.archive.completeRuns(), ['done-1']);
        await timers.advance(1);
        createRun(service, { runId: 'done-2', agentIds: ['agent-1'], completed: true });
        await timers.advance(COMPLETION_CONFIG.quietMs);
        assertEquals(await fixture.archive.completeRuns(), ['done-2']);

        fixture.persistence.persist();
        await recorder.stop();
        await timers.advance(FLUSH_INTERVAL_MS * 2);

        assertEquals(service.snapshotRun('done-1'), undefined);
        assertEquals(service.snapshotRun('done-2')?.completion?.file.state, 'present');
        await assertMissing(toCompletionFilePath(storageDir, 'done-1'));
        await assertMissing(`${storageDir}/runs/${toRunDirectoryName('done-1')}`);
        await Deno.stat(toCompletionFilePath(storageDir, 'done-2'));
        assertEquals((await readPersistedSnapshot(storageDir)).runs.map((run) => run.runId), ['done-2']);
    });
});

Deno.test('a completed run refuses new commands and distributed runs, and its agents cannot register again', async () => {
    await withStorageDir('refusal', async (storageDir) => {
        const timers = createManualTimers(START_EPOCH_MS);
        const fixture = toFixture({ storageDir, timers });
        createRuns(fixture.service, 1, 0);
        await timers.advance(COMPLETION_CONFIG.quietMs);
        assertEquals(await fixture.archive.completeRuns(), ['done-1']);
        const revision = fixture.service.snapshotRevision().content;

        const register = fixture.service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'done-1', agentId: 'agent-1' }));
        const command = fixture.service.enqueueCommand({ runId: 'done-1', agentId: 'agent-1', command: { kind: 'health' } });
        const distributed = fixture.service.createDistributedRun(
            toDistributedManifest({ distributedRunId: 'dist-late', controlRunId: 'done-1' })
        );

        assertEquals(register.accepted, false);
        assertEquals(command.left?.code, 'run-completed');
        assertEquals(distributed.left?.code, 'run-completed');
        assertEquals(fixture.service.snapshotRun('done-1')?.agents.every((agent) => !agent.connected), true);
        assertEquals(fixture.service.snapshotRevision().content, revision);
    });
});

Deno.test('a completed run keeps its fleet report, generated before its rows left memory', async () => {
    await withStorageDir('fleet', async (storageDir) => {
        const timers = createManualTimers(START_EPOCH_MS);
        const fixture = toFixture({ storageDir, timers });
        createRuns(fixture.service, 1, 0);
        await timers.advance(COMPLETION_CONFIG.quietMs);
        assertEquals(await fixture.archive.completeRuns(), ['done-1']);

        const report = fixture.service.snapshotFleetReport(toDistributedRunId('done-1'));

        assert(report);
        assertEquals(report.timing.commands.count, 4, 'the stage and start durations came from the rows, not from the index entry');
        assertEquals(report.agents.length, 2);
    });
});

Deno.test('the run and distributed-run read routes serve a completed run from its file and report a missing file', async () => {
    await withStorageDir('routes', async (storageDir) => {
        const timers = createManualTimers(START_EPOCH_MS);
        const fixture = toFixture({ storageDir, timers });
        createRuns(fixture.service, 2, 0);
        await timers.advance(COMPLETION_CONFIG.quietMs);
        assertEquals((await fixture.archive.completeRuns()).toSorted(), ['done-1', 'done-2']);
        await Deno.remove(toCompletionFilePath(storageDir, 'done-2'));
        const responses = createControlHttpResponses([]);
        const recorder = new ControlArtifactRecorder({
            storageDir: undefined,
            commandSnapshots: fixture.service,
            timers,
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
        });
        const runDependencies = { controlService: fixture.service, completedRuns: fixture.archive, artifactRecorder: recorder, responses };
        const distributedDependencies = { controlService: fixture.service, completedRuns: fixture.archive, responses, now: () => timers.nowMs() };
        const toUrl = (path: string) => new URL(`http://control.test${path}`);

        const run = await routeRunReadRequest(toUrl('/runs/done-1'), runDependencies);
        const bounded = await routeRunReadRequest(toUrl('/runs/done-1?limitEvents=3'), runDependencies);
        const bundle = await routeRunReadRequest(toUrl('/runs/done-1/artifacts'), runDependencies);
        const resultsJsonl = await routeRunReadRequest(toUrl('/runs/done-1/results.jsonl'), runDependencies);
        const failureBundle = await routeRunReadRequest(toUrl('/runs/done-1/failure-bundle'), runDependencies);
        const listing = await routeRunReadRequest(toUrl('/runs'), runDependencies);
        const { value: missing } = await withSilencedConsole(() => routeRunReadRequest(toUrl('/runs/done-2'), runDependencies));
        const absent = await routeRunReadRequest(toUrl('/runs/nope'), runDependencies);
        const distributedBundle = routeDistributedRunReadRequest(toUrl('/distributed-runs/dist-done-1/artifacts'), distributedDependencies);

        const served = JSON.parse(await run!.text()) as ControlRunSnapshot;
        assertEquals(run?.status, 200);
        assertEquals(served.events.length, EVENTS_PER_RUN);
        assertEquals(served.completion?.file.state, 'present');
        assertEquals((JSON.parse(await bounded!.text()) as ControlRunSnapshot).events.length, 3);
        const bundleReport = JSON.parse((JSON.parse(await bundle!.text()) as { files: Record<string, string>; }).files['report.json']);
        assertEquals(bundleReport.summary.total, 4);
        assertEquals(bundleReport.outputs.eventCount, EVENTS_PER_RUN);
        assertEquals(resultsJsonl?.status, 200);
        assertEquals((await resultsJsonl!.text()).trim().split('\n').length, 4);
        assertEquals(JSON.parse(await failureBundle!.text()).summary.total, 4);
        const listed = JSON.parse(await listing!.text()) as ControlServerSnapshot;
        assertEquals(listed.runs.map((entry) => [entry.runId, entry.events.length, entry.completion?.file.state]), [
            ['done-1', 0, 'present'],
            ['done-2', 0, 'present']
        ]);
        assertEquals(missing?.status, 410);
        assert((await missing!.text()).includes('done-2'));
        assertEquals(absent?.status, 404);
        const distributed = JSON.parse(await (await distributedBundle)!.text()) as { files: Record<string, string>; };
        assertEquals((JSON.parse(distributed.files['control-run.json']) as ControlRunSnapshot).events.length, EVENTS_PER_RUN);
        assertEquals(JSON.parse(distributed.files['report.json']).summary.total, 4);
    });
});

async function assertMissing(path: string): Promise<void> {
    try {
        await Deno.stat(path);
    }
    catch (error) {
        assert(error instanceof Deno.errors.NotFound);
        return;
    }
    throw new Error(`${path} still exists`);
}
