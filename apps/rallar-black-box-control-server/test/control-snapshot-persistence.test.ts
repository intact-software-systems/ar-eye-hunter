import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RallarTimingEvent, RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC } from '@shared-test/rallar-bb-test/barrier/control-barrier-protocol.ts';
import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxTestRecord } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultTimers, type Timers } from '@shared/resilience/timers.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { toRallarBlackBoxCompositeResultFlatEntries } from '@shared-test/rallar-bb-test/composite-results.ts';
import { parseControlClientMessage, RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import type { RallarBlackBoxDistributedTargetBlocker } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeJsonValue, decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { toRtcCaptureReadout } from '@shared-web/browser/connection/to-rtc-capture-readout.ts';

import { decodeControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';

import { createManualTimers } from '../../../packages/tests/shared/resilience/manual-timers.ts';
import { ControlAgentSockets } from '../src/control-agent-sockets.ts';
import {
    ControlArtifactRecorder,
    DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
} from '../src/control-artifact-recorder.ts';
import { toRunDirectoryName } from '../src/control-artifact-storage.ts';
import { createRallarBlackBoxControlService, type RallarBlackBoxControlService } from '../src/control-service.ts';
import { ControlSnapshotPersistence } from '../src/control-snapshot-persistence.ts';
import { toJsonPieces } from '../src/run-completion/control-sliced-json-file.ts';
import {
    assertRight,
    toCommandResultEnvelope,
    toControlServiceInput,
    toDistributedManifest,
    toFleetIdentity,
    toHeartbeatEnvelope,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';
import { createDistributedRunArtifactBundle } from './support/create-distributed-run-artifact-bundle.ts';
import { takeAgentDispatchableCommands } from './support/take-agent-dispatchable-commands.ts';

function toStagedService(): RallarBlackBoxControlService {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    for (const agentId of ['agent-1', 'agent-2']) {
        service.receiveClientEnvelope(toRegisterEnvelope({
            runId: 'run-1',
            agentId,
            completedCommandIds: [],
            identity: toFleetIdentity(agentId)
        }));
    }
    assertRight(service.createDistributedRun(toDistributedManifest()));
    assertRight(service.stageDistributedRun('dist-1'));
    const [stageCommand] = takeAgentDispatchableCommands(service, 'run-1', 'agent-1');
    service.receiveClientEnvelope(toCommandResultEnvelope({
        runId: 'run-1',
        agentId: 'agent-1',
        command: stageCommand,
        ok: true
    }));
    return service;
}

const FLUSH_INTERVAL_MS = 500;

interface SnapshotPersistenceFixtureInput {
    readonly storageDir: string;
    readonly controlService: ConstructorParameters<typeof ControlSnapshotPersistence>[0]['controlService'];
    readonly timers?: Timers;
    readonly timingSink?: RallarTimingSink;
}

function toSnapshotPersistence(input: SnapshotPersistenceFixtureInput): ControlSnapshotPersistence {
    return new ControlSnapshotPersistence({
        storageDir: input.storageDir,
        retentionMaxRuns: 50,
        snapshotBounds: {},
        flushIntervalMs: FLUSH_INTERVAL_MS,
        controlService: input.controlService,
        deleteRuns: () => undefined,
        timers: input.timers ?? createDefaultTimers(),
        timingSink: input.timingSink
    });
}

/** Counts the snapshot projections, each of which the persistence serializes. */
function toCountingControlService(
    service: RallarBlackBoxControlService,
    onSnapshot: () => void
): SnapshotPersistenceFixtureInput['controlService'] {
    return {
        applyCompletedRunRetention: (maxRuns) => service.applyCompletedRunRetention(maxRuns),
        restoreSnapshot: (snapshot) => service.restoreSnapshot(snapshot),
        snapshotLifecycleRevision: () => service.snapshotLifecycleRevision(),
        snapshotRevision: () => service.snapshotRevision(),
        snapshotForPersistence: (bounds) => {
            onSnapshot();
            return service.snapshotForPersistence(bounds);
        }
    };
}

interface SnapshotRestoreResult {
    readonly service: RallarBlackBoxControlService;
    readonly warnings: readonly string[];
}

async function restoreSnapshotText(
    snapshot: object
): Promise<SnapshotRestoreResult> {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-snapshot-restore-'));
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    const warnings: string[] = [];
    const warn = console.warn;
    const log = console.log;
    console.warn = (message: string) => warnings.push(message);
    console.log = () => undefined;
    try {
        await writeFile(`${storageDir}/control-snapshot.json`, JSON.stringify({ schemaVersion: 1, savedAtEpochMs: 1_000, snapshot }), 'utf8');
        await toSnapshotPersistence({ storageDir, controlService: service }).restore();
        return { service, warnings };
    }
    finally {
        console.warn = warn;
        console.log = log;
        await rm(storageDir, { recursive: true, force: true });
    }
}

test('control snapshot restore brings back the runs and distributed runs this server persisted', async () => {
    const persisted = toStagedService().snapshotForPersistence({});

    const { service, warnings } = await restoreSnapshotText(persisted);

    expect(warnings).toEqual([]);
    expect(service.snapshotRun('run-1')?.agents.map((agent) => agent.agentId)).toEqual(['agent-1', 'agent-2']);
    expect(service.snapshotDistributedRun('dist-1')?.manifest).toEqual(persisted.distributedRuns?.[0]?.manifest);
});

test('control snapshot persistence writes compact JSON once per changed snapshot and never serializes an unchanged one', async () => {
    const service = toStagedService();
    const timers = createManualTimers(10_000);
    let serializations = 0;
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-snapshot-change-'));
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    try {
        const persistence = toSnapshotPersistence({
            storageDir,
            controlService: toCountingControlService(service, () => serializations += 1),
            timers
        });
        persistence.persist();
        await timers.advanceTo(10_000);
        const first = await readFile(snapshotPath, 'utf8');

        persistence.persist();
        persistence.persist();
        await timers.advanceTo(10_000 + FLUSH_INTERVAL_MS * 4);
        const unchanged = await readFile(snapshotPath, 'utf8');
        const serializationsWhileUnchanged = serializations;

        service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-3', identity: toFleetIdentity('agent-3') }));
        persistence.persist();
        await timers.advanceTo(10_000 + FLUSH_INTERVAL_MS * 8);
        const changed = await readFile(snapshotPath, 'utf8');

        expect(serializationsWhileUnchanged).toEqual(1);
        expect(unchanged).toEqual(first);
        expect(serializations).toEqual(2);
        expect(first.includes('\n')).toEqual(false);
        const restored = await restoreSnapshotText(JSON.parse(changed).snapshot);
        expect(restored.warnings).toEqual([]);
        expect(restored.service.snapshotRun('run-1')?.agents.map((agent) => agent.agentId).sort()).toEqual(['agent-1', 'agent-2', 'agent-3']);
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

// Every flush serializes every retained run, so flushes per burst is the cost being bounded.
test('a 2 s burst of 1,000 accepted envelopes writes the snapshot at most once per flush interval plus the trailing write', async () => {
    const burstMs = 2_000;
    const startEpochMs = 10_000;
    const service = toStagedService();
    const timers = createManualTimers(startEpochMs);
    let serializations = 0;
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-snapshot-burst-'));
    try {
        const persistence = toSnapshotPersistence({
            storageDir,
            controlService: toCountingControlService(service, () => serializations += 1),
            timers
        });
        persistence.persist();
        await timers.advanceTo(startEpochMs);
        serializations = 0;

        for (let index = 1; index <= 1_000; index += 1) {
            service.receiveClientEnvelope(toHeartbeatEnvelope({ runId: 'run-1', agentId: 'agent-1', atEpochMs: startEpochMs + index * 2 }));
            persistence.persist();
            await timers.advanceTo(startEpochMs + index * 2);
        }
        await timers.advanceTo(startEpochMs + burstMs + FLUSH_INTERVAL_MS);
        const persisted = JSON.parse(await readFile(`${storageDir}/control-snapshot.json`, 'utf8'));

        assert(serializations <= Math.ceil(burstMs / FLUSH_INTERVAL_MS) + 1);
        expect(persisted.snapshot.runs[0].heartbeats.at(-1).atEpochMs).toEqual(startEpochMs + burstMs);
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('a distributed-run lifecycle change and shutdown write the snapshot at once', async () => {
    const service = toStagedService();
    const timers = createManualTimers(10_000);
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-snapshot-lifecycle-'));
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    const persistedState = async () => JSON.parse(await readFile(snapshotPath, 'utf8')).snapshot.distributedRuns[0].state;
    try {
        const persistence = toSnapshotPersistence({ storageDir, controlService: service, timers });
        persistence.persist();
        await timers.advanceTo(10_000);
        const staged = await persistedState();

        assertRight(service.cancelDistributedRun('dist-1', 'operator stop'));
        persistence.persist();
        await timers.advanceTo(10_001);
        const cancelled = await persistedState();

        service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-3', identity: toFleetIdentity('agent-3') }));
        persistence.persist();
        await persistence.stop();
        const stopped = JSON.parse(await readFile(snapshotPath, 'utf8')).snapshot.runs[0].agents.length;

        expect([staged, cancelled, stopped]).toEqual(['waiting-for-ack', 'cancelled', 3]);
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('a snapshot read that throws during a flush is logged as a warning with its cause', async () => {
    const service = toStagedService();
    const timers = createManualTimers(10_000);
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-snapshot-throw-'));
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
        const persistence = toSnapshotPersistence({
            storageDir,
            controlService: toCountingControlService(service, () => {
                throw new Error('snapshot projection failed');
            }),
            timers
        });
        persistence.persist();
        await timers.advanceTo(10_000);
        await persistence.stop();

        expect(warnings).toEqual([
            `Could not persist control snapshot to ${storageDir}/control-snapshot.json: snapshot projection failed`
        ]);
    }
    finally {
        console.warn = warn;
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('control snapshot restore rejects a distributed run whose manifest omits a now-required setting', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    const distributedRun = persisted.distributedRuns[0];
    delete distributedRun.manifest.groupAssertions;

    const { service, warnings } = await restoreSnapshotText(persisted);

    expect(service.listDistributedRuns()).toEqual([]);
    expect(service.snapshotRun('run-1')).toEqual(undefined);
    expect(warnings.length).toEqual(1);
    assert(warnings[0].includes('distributedRuns[0]: manifest is not a valid distributed run manifest'));
    assert(warnings[0].includes('$: Missing required property groupAssertions.'));
});

test('control snapshot restore rejects a resolved role assignment without its recipe scope', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    const resolution = persisted.distributedRuns[0].targetResolution;
    resolution.roleAssignments = [{ role: 'sender', agentId: 'agent-1' }];

    const { service, warnings } = await restoreSnapshotText(persisted);

    expect(service.listDistributedRuns()).toEqual([]);
    expect(warnings.length).toEqual(1);
    assert(warnings[0].includes('targetResolution.roleAssignments[0].recipeIds must be an array of strings'));
});

test('control snapshot restore rejects an agent identity without its session label', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    delete persisted.runs[0].agents[0].identity.sessionLabel;

    const { service, warnings } = await restoreSnapshotText(persisted);

    expect(service.snapshotRun('run-1')).toEqual(undefined);
    expect(warnings.length).toEqual(1);
    assert(warnings[0].includes('agents[0].identity.sessionLabel must be a non-empty string'));
});

test('control snapshot restore rejects a snapshot without its fleet reports instead of restoring none', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    delete persisted.fleetReports;

    const { service, warnings } = await restoreSnapshotText(persisted);

    expect(service.snapshotRun('run-1')).toEqual(undefined);
    expect(service.listDistributedRuns()).toEqual([]);
    expect(warnings.length).toEqual(1);
    assert(warnings[0].endsWith(': fleetReports must be an array'));
});

test('control snapshot restore rejects a snapshot without its distributed runs instead of restoring none', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    delete persisted.distributedRuns;

    const { service, warnings } = await restoreSnapshotText(persisted);

    expect(service.snapshotRun('run-1')).toEqual(undefined);
    expect(warnings.length).toEqual(1);
    assert(warnings[0].endsWith(': distributedRuns must be an array'));
});

test('capture admission preserves an unidentified capture blocker through decode, restore and export', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    const blocker: RallarBlackBoxDistributedTargetBlocker = {
        agentId: 'agent-2',
        status: 'missing-rtc-capture-capability',
        reason: 'Required RTC capture target has no identity.'
    };
    persisted.distributedRuns[0].targetResolution.blockers = [blocker];

    const decoded = assertRight(decodeControlDistributedRunSnapshot(persisted.distributedRuns[0]));
    expect(decoded.targetResolution?.blockers).toEqual([blocker]);
    const { service, warnings } = await restoreSnapshotText(persisted);
    expect(warnings).toEqual([]);
    expect(service.snapshotDistributedRun('dist-1')?.targetResolution?.blockers).toEqual([blocker]);
    const bundle = createDistributedRunArtifactBundle(service, 'dist-1');
    assert(bundle);
    const exported = assertRight(decodeControlDistributedRunSnapshot(JSON.parse(bundle.files['distributed-run.json'])));
    expect(exported.targetResolution?.blockers).toEqual([blocker]);
});

test('capture admission rejects supplied malformed identities and requires identities for other statuses', () => {
    const snapshot = JSON.parse(JSON.stringify(toStagedService().snapshotDistributedRun('dist-1')));
    for (
        const blocker of [
            { status: 'missing-rtc-capture-capability', identity: null },
            { status: 'missing-rtc-capture-capability', identity: {} },
            { status: 'offline-agent' },
            { status: 'stale-agent' },
            { status: 'different-group' },
            { status: 'missing-assertion-capability' }
        ]
    ) {
        snapshot.targetResolution.blockers = [{ agentId: 'agent-2', reason: 'Unavailable target.', ...blocker }];
        assert(decodeControlDistributedRunSnapshot(snapshot).left !== undefined);
    }
    snapshot.targetResolution.blockers = [{
        agentId: 'agent-2',
        status: 'missing-rtc-capture-capability',
        reason: 'Required capture mode is unavailable.',
        identity: toFleetIdentity('agent-2')
    }];
    assert(decodeControlDistributedRunSnapshot(snapshot).right !== undefined);
});

/** The optional handoff file is produced by the real private SDK Vitest seat; literal receipts cannot satisfy this test. */
const sdkReceiptWitnessPath = process.env['RALLAR_SDK_RECEIPT_WITNESS_PATH'];
const sdkReceiptTest = sdkReceiptWitnessPath === undefined ? test.skip : test;
sdkReceiptTest('actual SDK provenance survives native persistence, restore, disk JSONL, fallback and distributed export', async () => {
    if (sdkReceiptWitnessPath === undefined) {
        throw new Error('RALLAR_SDK_RECEIPT_WITNESS_PATH is required for this test.');
    }
    const witnessPath = sdkReceiptWitnessPath;
    const text = await readFile(witnessPath, 'utf8');
    const witness = decodeRecord(JSON.parse(text));
    const producer = decodeRecord(witness.producer);
    const receipt = assertRight(toRtcCaptureReadout(decodeJsonValue(witness.receipt)));
    const invocation = decodeRecord(witness.invocation);
    const source = await readFile(
        new URL('../../../packages/tests/shared-test/rallar-browser-runtime/recipe-rtc-capture-application.test.ts', import.meta.url)
    );
    expect(producer.sourceSha256).toEqual(await sha256(source));
    expect(producer.test).toEqual('actual SDK distributed Off receipt and replay');
    const persisted = decodeRecord(witness.snapshot);
    assert(Array.isArray(persisted.runs));
    const run = assertRight(decodeControlRunSnapshot(persisted.runs[0]));
    assert(Array.isArray(persisted.distributedRuns));
    const distributedRuns = persisted.distributedRuns.map((value) => assertRight(decodeControlDistributedRunSnapshot(value)));
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.restoreSnapshot({ runs: [run], distributedRuns, fleetReports: [] });
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-sdk-receipt-disk-'));
    try {
        const persistence = toSnapshotPersistence({ storageDir, controlService: service });
        persistence.persist();
        await persistence.stop();
        const diskText = await readFile(`${storageDir}/control-snapshot.json`, 'utf8');
        assert(diskText.includes(String(witness.commandId)));
        const restored = createRallarBlackBoxControlService(toControlServiceInput());
        await toSnapshotPersistence({ storageDir, controlService: restored }).restore();
        const restoredRun = restored.snapshotRun(run.runId);
        assert(restoredRun);
        const root = restoredRun.results.find((entry) => entry.commandId === witness.commandId);
        assert(root?.result);
        expect(root.replayed).toEqual(true);
        expect(root.result.replayed).toEqual(true);
        expect(decodeRecord(root.result.value).invocation).toEqual(invocation);
        assertSdkCaptureReceipts(root.result, receipt);
        const recorder = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: restored,
            timers: createDefaultTimers(),
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
        });
        assert(Array.isArray(witness.envelopes));
        for (const value of witness.envelopes) {
            const parsed = parseControlClientMessage(value);
            assert(parsed.ok);
            recorder.record(parsed.envelope);
        }
        const diskResponse = await recorder.response({ runId: run.runId, kind: 'results', fallbackRun: restoredRun, corsOrigins: [] });
        const diskRows = await diskResponse.text();
        expect(diskRows).toEqual(await readFile(`${storageDir}/runs/${toRunDirectoryName(run.runId)}/results.jsonl`, 'utf8'));
        assertSdkArtifactReceipt({ text: diskRows, result: root.result, receipt: receipt, invocation: invocation });
        const fallback = new ControlArtifactRecorder({
            storageDir: undefined,
            commandSnapshots: restored,
            timers: createDefaultTimers(),
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
        });
        const fallbackText = await (await fallback.response({ runId: run.runId, kind: 'results', fallbackRun: restoredRun, corsOrigins: [] })).text();
        assertSdkArtifactReceipt({ text: fallbackText, result: root.result, receipt: receipt, invocation: invocation });
        const bundle = createDistributedRunArtifactBundle(restored, 'sdk-distributed');
        assert(bundle);
        const exported = assertRight(decodeControlRunSnapshot(JSON.parse(bundle.files['control-run.json'])));
        const exportedRoot = exported.results.find((entry) => entry.commandId === witness.commandId);
        assert(exportedRoot?.result);
        assertSdkCaptureReceipts(exportedRoot.result, receipt);
        expect(restored.snapshotDistributedRun('sdk-distributed')?.commandLinks.find((link) => link.commandId === witness.commandId)?.phase).toEqual('start');
        for (
            const [suffix, artifact] of [
                ['native-snapshot.json', diskText],
                ['native-disk-results.jsonl', diskRows],
                ['native-fallback-results.jsonl', fallbackText],
                ['native-distributed-control-run.json', bundle.files['control-run.json']]
            ]
        ) {
            await writeFile(`${witnessPath}.${suffix}`, artifact, { encoding: 'utf8', flag: 'wx' });
        }
        console.log(
            `Native SDK disk lineage: input SHA256 ${await sha256(new TextEncoder().encode(text))}; snapshot SHA256 ${await sha256(
                new TextEncoder().encode(diskText)
            )}; disk JSONL SHA256 ${await sha256(new TextEncoder().encode(diskRows))}`
        );
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

async function sha256(value: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertSdkCaptureReceipts(result: RallarBlackBoxTestResult, receipt: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>): void {
    const connections = toRallarBlackBoxCompositeResultFlatEntries([result]).filter((entry) => entry.kind === 'rtc.connect');
    expect(connections.length).toEqual(4);
    expect(new Set(connections.map((entry) => entry.path)).size).toEqual(4);
    for (const connection of connections) {
        expect(toRtcCaptureReadout(decodeJsonValue(decodeRecord(connection.result.value).rtcCapture)).right).toEqual(receipt);
    }
}

interface SdkArtifactReceiptInput {
    readonly text: string;
    readonly result: RallarBlackBoxTestResult;
    readonly receipt: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>;
    readonly invocation: RallarBlackBoxTestRecord;
}

function assertSdkArtifactReceipt(input: SdkArtifactReceiptInput): void {
    const row = input.text.trim().split('\n').map((line) => decodeRecord(JSON.parse(line)))
        .find((entry) => entry.commandId === input.result.commandId);
    assert(row);
    const actual = decodeRecord(row.actual);
    expect(actual.invocation).toEqual(input.invocation);
    assertSdkCaptureReceipts({ ...input.result, value: actual }, input.receipt);
}

const SLOW_SLICES = 8;
const SLOW_SLICE_MS = 60;

test('the sliced snapshot serialization is exactly JSON.stringify of the snapshot', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    for (const agentId of ['agent-1', 'agent-2']) {
        service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId, identity: toFleetIdentity(agentId) }));
    }
    assertRight(service.createDistributedRun(toDistributedManifest()));
    assertRight(service.stageDistributedRun('dist-1'));
    const [stage] = takeAgentDispatchableCommands(service, 'run-1', 'agent-1');
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: stage, ok: true }));
    const snapshot = service.snapshotForPersistence({});
    const withEdgeValues = { ...snapshot, edge: [undefined, () => 1, { skipped: undefined, kept: null, date: new Date(0) }] };

    expect([...toJsonPieces(snapshot, 0)].join('')).toEqual(JSON.stringify(snapshot));
    expect([...toJsonPieces(withEdgeValues, 0)].join('')).toEqual(JSON.stringify(withEdgeValues));
});

// Before the serialization was sliced, a barrier arrival that landed during a flush waited for the whole
// JSON.stringify; on the hosted VM that held barrier resolutions for seconds.
test('a barrier arrival during a slow snapshot flush is resolved on its socket before the flush ends', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-snapshot-slow-flush-'));
    const timings: RallarTimingEvent[] = [];
    const service = createRallarBlackBoxControlService(toControlServiceInput({ timingSink: (event) => timings.push(event) }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1' }));
    const sockets = new ControlAgentSockets(service);
    let resolutionSentAt: number | undefined;
    sockets.register(
        { readyState: 1, send: () => resolutionSentAt ??= performance.now(), close: () => undefined },
        { runId: 'run-1', agentId: 'agent-1' }
    );
    try {
        const persistence = new ControlSnapshotPersistence({
            storageDir,
            retentionMaxRuns: 0,
            snapshotBounds: {},
            flushIntervalMs: 2_000,
            controlService: {
                applyCompletedRunRetention: () => [],
                restoreSnapshot: () => undefined,
                snapshotLifecycleRevision: () => '',
                snapshotRevision: () => ({ content: 'slow', lifecycle: '' }),
                snapshotForPersistence: () => toSlowSnapshot()
            },
            deleteRuns: () => undefined,
            timers: createDefaultTimers(),
            timingSink: (event) => timings.push(event)
        });
        persistence.persist();
        const arrivalDueAt = performance.now() + 20;
        setTimeout(() => {
            if (service.receiveClientEnvelope(toBarrierArrival()).affectsDispatch) {
                sockets.sendDispatchableCommandsForRun('run-1');
            }
        }, 20);
        await persistence.stop();
        const flushEndedAt = performance.now();
        const flush = timings.find((event) => event.operation === 'snapshot.flush');
        const resolution = timings.find((event) => event.operation === 'barrier.resolution');

        assert(resolutionSentAt !== undefined);
        assert(resolutionSentAt < flushEndedAt);
        assert(resolutionSentAt - arrivalDueAt < 4 * SLOW_SLICE_MS);
        expect(flush?.status).toEqual('ok');
        assert((flush?.details?.bytes ?? 0) as number > SLOW_SLICES * 1_000_000);
        assert((flush?.details?.serializeMs ?? 0) as number >= SLOW_SLICES * SLOW_SLICE_MS);
        expect(resolution?.details).toEqual({ barrierId: 'armed', outcome: 'failed', arrivals: 1, participants: 0 });
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

/** Every fleet report entry takes one slice and its serialization blocks for a fixed time, as a slow CPU would. */
function toSlowSnapshot(): ControlServerSnapshot {
    const slowEntry = {
        toJSON: () => {
            const until = performance.now() + SLOW_SLICE_MS;
            while (performance.now() < until) {
                // Busy wait: the serialization itself holds the event loop.
            }
            return 'x'.repeat(1_100_000);
        }
    };
    return { runs: [], distributedRuns: [], fleetReports: Array.from({ length: SLOW_SLICES }, () => slowEntry) } as never;
}

function toBarrierArrival() {
    return {
        kind: 'event',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_000,
        eventId: 'barrier-arrived',
        payload: {
            eventId: 'barrier-arrived',
            kind: 'event',
            topic: RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC,
            atEpochMs: 1_000,
            severity: 'info',
            payload: { barrierId: 'armed', timeoutMs: 5_000 }
        }
    } as const;
}
