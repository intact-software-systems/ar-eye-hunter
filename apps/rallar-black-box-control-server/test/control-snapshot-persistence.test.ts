import type { RallarBlackBoxTestRecord } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { assert, assertEquals } from '@std/assert';

import { toRallarBlackBoxCompositeResultFlatEntries } from '@shared-test/rallar-bb-test/composite-results.ts';
import { parseControlClientMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import type { RallarBlackBoxDistributedTargetBlocker } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeJsonValue, decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { toRtcCaptureReadout } from '@shared-web/browser/connection/to-rtc-capture-readout.ts';

import { decodeControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';

import {
    ControlArtifactRecorder,
    DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG,
    toRunDirectoryName
} from '../src/control-artifact-recorder.ts';
import { createRallarBlackBoxControlService, type RallarBlackBoxControlService } from '../src/control-service.ts';
import { ControlSnapshotPersistence } from '../src/control-snapshot-persistence.ts';
import { createDefaultControlTimers, type ControlTimers } from '../src/control-timers.ts';
import {
    assertRight,
    toCommandResultEnvelope,
    toControlServiceInput,
    toDistributedManifest,
    toFleetIdentity,
    toHeartbeatEnvelope,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';
import { createManualControlTimers } from './support/manual-control-timers.ts';
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
    readonly timers?: ControlTimers;
}

function toSnapshotPersistence(input: SnapshotPersistenceFixtureInput): ControlSnapshotPersistence {
    return new ControlSnapshotPersistence({
        storageDir: input.storageDir,
        retentionMaxRuns: 50,
        snapshotBounds: {},
        flushIntervalMs: FLUSH_INTERVAL_MS,
        controlService: input.controlService,
        deleteRuns: () => undefined,
        timers: input.timers ?? createDefaultControlTimers()
    });
}

/** Counts the snapshot projections, each of which the persistence serializes. */
function toCountingControlService(
    service: RallarBlackBoxControlService,
    onSnapshot: () => void
): SnapshotPersistenceFixtureInput['controlService'] {
    return {
        applyRunRetention: (maxRuns) => service.applyRunRetention(maxRuns),
        restoreSnapshot: (snapshot) => service.restoreSnapshot(snapshot),
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
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-snapshot-restore-' });
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    const warnings: string[] = [];
    const warn = console.warn;
    const log = console.log;
    console.warn = (message: string) => warnings.push(message);
    console.log = () => undefined;
    try {
        await Deno.writeTextFile(
            `${storageDir}/control-snapshot.json`,
            JSON.stringify({ schemaVersion: 1, savedAtEpochMs: 1_000, snapshot })
        );
        await toSnapshotPersistence({ storageDir, controlService: service }).restore();
        return { service, warnings };
    }
    finally {
        console.warn = warn;
        console.log = log;
        await Deno.remove(storageDir, { recursive: true });
    }
}

Deno.test('control snapshot restore brings back the runs and distributed runs this server persisted', async () => {
    const persisted = toStagedService().snapshotForPersistence({});

    const { service, warnings } = await restoreSnapshotText(persisted);

    assertEquals(warnings, []);
    assertEquals(service.snapshotRun('run-1')?.agents.map((agent) => agent.agentId), ['agent-1', 'agent-2']);
    assertEquals(service.snapshotDistributedRun('dist-1')?.manifest, persisted.distributedRuns?.[0]?.manifest);
});

Deno.test('control snapshot persistence writes compact JSON once per changed snapshot and never serializes an unchanged one', async () => {
    const service = toStagedService();
    const timers = createManualControlTimers(10_000);
    let serializations = 0;
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-snapshot-change-' });
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    try {
        const persistence = toSnapshotPersistence({
            storageDir,
            controlService: toCountingControlService(service, () => serializations += 1),
            timers
        });
        persistence.persist();
        await timers.advanceTo(10_000);
        const first = await Deno.readTextFile(snapshotPath);

        persistence.persist();
        persistence.persist();
        await timers.advanceTo(10_000 + FLUSH_INTERVAL_MS * 4);
        const unchanged = await Deno.readTextFile(snapshotPath);
        const serializationsWhileUnchanged = serializations;

        service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-3', identity: toFleetIdentity('agent-3') }));
        persistence.persist();
        await timers.advanceTo(10_000 + FLUSH_INTERVAL_MS * 8);
        const changed = await Deno.readTextFile(snapshotPath);

        assertEquals(serializationsWhileUnchanged, 1, 'an unchanged revision is not serialized again');
        assertEquals(unchanged, first, 'an unchanged snapshot is not rewritten');
        assertEquals(serializations, 2);
        assertEquals(first.includes('\n'), false, 'the snapshot file is compact');
        const restored = await restoreSnapshotText(JSON.parse(changed).snapshot);
        assertEquals(restored.warnings, []);
        assertEquals(restored.service.snapshotRun('run-1')?.agents.map((agent) => agent.agentId).sort(), ['agent-1', 'agent-2', 'agent-3']);
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

// Every flush serializes every retained run, so flushes per burst is the cost being bounded.
Deno.test('a 2 s burst of 1,000 accepted envelopes writes the snapshot at most once per flush interval plus the trailing write', async () => {
    const burstMs = 2_000;
    const startEpochMs = 10_000;
    const service = toStagedService();
    const timers = createManualControlTimers(startEpochMs);
    let serializations = 0;
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-snapshot-burst-' });
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
        const persisted = JSON.parse(await Deno.readTextFile(`${storageDir}/control-snapshot.json`));

        assert(serializations <= Math.ceil(burstMs / FLUSH_INTERVAL_MS) + 1, `${serializations} flushes in ${burstMs} ms`);
        assertEquals(persisted.snapshot.runs[0].heartbeats.at(-1).atEpochMs, startEpochMs + burstMs, 'the trailing write holds the last envelope');
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('a distributed-run lifecycle change and shutdown write the snapshot at once', async () => {
    const service = toStagedService();
    const timers = createManualControlTimers(10_000);
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-snapshot-lifecycle-' });
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    const persistedState = async () => JSON.parse(await Deno.readTextFile(snapshotPath)).snapshot.distributedRuns[0].state;
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
        const stopped = JSON.parse(await Deno.readTextFile(snapshotPath)).snapshot.runs[0].agents.length;

        assertEquals([staged, cancelled, stopped], ['waiting-for-ack', 'cancelled', 3]);
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('control snapshot restore rejects a distributed run whose manifest omits a now-required setting', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    const distributedRun = persisted.distributedRuns[0];
    delete distributedRun.manifest.groupAssertions;

    const { service, warnings } = await restoreSnapshotText(persisted);

    assertEquals(service.listDistributedRuns(), []);
    assertEquals(service.snapshotRun('run-1'), undefined);
    assertEquals(warnings.length, 1);
    assert(warnings[0].includes('distributedRuns[0]: manifest is not a valid distributed run manifest'), warnings[0]);
    assert(warnings[0].includes('$: Missing required property groupAssertions.'), warnings[0]);
});

Deno.test('control snapshot restore rejects a resolved role assignment without its recipe scope', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    const resolution = persisted.distributedRuns[0].targetResolution;
    resolution.roleAssignments = [{ role: 'sender', agentId: 'agent-1' }];

    const { service, warnings } = await restoreSnapshotText(persisted);

    assertEquals(service.listDistributedRuns(), []);
    assertEquals(warnings.length, 1);
    assert(warnings[0].includes('targetResolution.roleAssignments[0].recipeIds must be an array of strings'), warnings[0]);
});

Deno.test('control snapshot restore rejects an agent identity without its session label', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    delete persisted.runs[0].agents[0].identity.sessionLabel;

    const { service, warnings } = await restoreSnapshotText(persisted);

    assertEquals(service.snapshotRun('run-1'), undefined);
    assertEquals(warnings.length, 1);
    assert(warnings[0].includes('agents[0].identity.sessionLabel must be a non-empty string'), warnings[0]);
});

Deno.test('control snapshot restore rejects a snapshot without its fleet reports instead of restoring none', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    delete persisted.fleetReports;

    const { service, warnings } = await restoreSnapshotText(persisted);

    assertEquals(service.snapshotRun('run-1'), undefined);
    assertEquals(service.listDistributedRuns(), []);
    assertEquals(warnings.length, 1);
    assert(warnings[0].endsWith(': fleetReports must be an array'), warnings[0]);
});

Deno.test('control snapshot restore rejects a snapshot without its distributed runs instead of restoring none', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    delete persisted.distributedRuns;

    const { service, warnings } = await restoreSnapshotText(persisted);

    assertEquals(service.snapshotRun('run-1'), undefined);
    assertEquals(warnings.length, 1);
    assert(warnings[0].endsWith(': distributedRuns must be an array'), warnings[0]);
});

Deno.test('capture admission preserves an unidentified capture blocker through decode, restore and export', async () => {
    const persisted = JSON.parse(JSON.stringify(toStagedService().snapshotForPersistence({})));
    const blocker: RallarBlackBoxDistributedTargetBlocker = {
        agentId: 'agent-2',
        status: 'missing-rtc-capture-capability',
        reason: 'Required RTC capture target has no identity.'
    };
    persisted.distributedRuns[0].targetResolution.blockers = [blocker];

    const decoded = assertRight(decodeControlDistributedRunSnapshot(persisted.distributedRuns[0]));
    assertEquals(decoded.targetResolution?.blockers, [blocker]);
    const { service, warnings } = await restoreSnapshotText(persisted);
    assertEquals(warnings, []);
    assertEquals(service.snapshotDistributedRun('dist-1')?.targetResolution?.blockers, [blocker]);
    const bundle = service.createDistributedRunArtifactBundle('dist-1', {});
    assert(bundle);
    const exported = assertRight(decodeControlDistributedRunSnapshot(JSON.parse(bundle.files['distributed-run.json'])));
    assertEquals(exported.targetResolution?.blockers, [blocker]);
});

Deno.test('capture admission rejects supplied malformed identities and requires identities for other statuses', () => {
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
Deno.test({
    name: 'actual SDK provenance survives native persistence, restore, disk JSONL, fallback and distributed export',
    ignore: Deno.env.get('RALLAR_SDK_RECEIPT_WITNESS_PATH') === undefined,
    fn: async () => {
        const witnessPath = Deno.env.get('RALLAR_SDK_RECEIPT_WITNESS_PATH');
        assert(witnessPath);
        const text = await Deno.readTextFile(witnessPath);
        const witness = decodeRecord(JSON.parse(text));
        const producer = decodeRecord(witness.producer);
        const receipt = assertRight(toRtcCaptureReadout(decodeJsonValue(witness.receipt)));
        const invocation = decodeRecord(witness.invocation);
        const source = await Deno.readFile(
            new URL('../../../packages/tests/shared-test/rallar-browser-runtime/recipe-rtc-capture-application.test.ts', import.meta.url)
        );
        assertEquals(producer.sourceSha256, await sha256(source));
        assertEquals(producer.test, 'actual SDK distributed Off receipt and replay');
        const persisted = decodeRecord(witness.snapshot);
        assert(Array.isArray(persisted.runs));
        const run = assertRight(decodeControlRunSnapshot(persisted.runs[0]));
        assert(Array.isArray(persisted.distributedRuns));
        const distributedRuns = persisted.distributedRuns.map((value) => assertRight(decodeControlDistributedRunSnapshot(value)));
        const service = createRallarBlackBoxControlService(toControlServiceInput());
        service.restoreSnapshot({ runs: [run], distributedRuns, fleetReports: [] });
        const storageDir = await Deno.makeTempDir({ prefix: 'rallar-sdk-receipt-disk-' });
        try {
            const persistence = toSnapshotPersistence({ storageDir, controlService: service });
            persistence.persist();
            await persistence.stop();
            const diskText = await Deno.readTextFile(`${storageDir}/control-snapshot.json`);
            assert(diskText.includes(String(witness.commandId)));
            const restored = createRallarBlackBoxControlService(toControlServiceInput());
            await toSnapshotPersistence({ storageDir, controlService: restored }).restore();
            const restoredRun = restored.snapshotRun(run.runId);
            assert(restoredRun);
            const root = restoredRun.results.find((entry) => entry.commandId === witness.commandId);
            assert(root?.result);
            assertEquals(root.replayed, true);
            assertEquals(root.result.replayed, true);
            assertEquals(decodeRecord(root.result.value).invocation, invocation);
            assertSdkCaptureReceipts(root.result, receipt);
            const recorder = new ControlArtifactRecorder({
                storageDir,
                commandSnapshots: restored,
                timers: createDefaultControlTimers(),
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
            assertEquals(diskRows, await Deno.readTextFile(`${storageDir}/runs/${toRunDirectoryName(run.runId)}/results.jsonl`));
            assertSdkArtifactReceipt({ text: diskRows, result: root.result, receipt: receipt, invocation: invocation });
            const fallback = new ControlArtifactRecorder({
                storageDir: undefined,
                commandSnapshots: restored,
                timers: createDefaultControlTimers(),
                config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
            });
            const fallbackText = await (await fallback.response({ runId: run.runId, kind: 'results', fallbackRun: restoredRun, corsOrigins: [] })).text();
            assertSdkArtifactReceipt({ text: fallbackText, result: root.result, receipt: receipt, invocation: invocation });
            const bundle = restored.createDistributedRunArtifactBundle('sdk-distributed', {});
            assert(bundle);
            const exported = assertRight(decodeControlRunSnapshot(JSON.parse(bundle.files['control-run.json'])));
            const exportedRoot = exported.results.find((entry) => entry.commandId === witness.commandId);
            assert(exportedRoot?.result);
            assertSdkCaptureReceipts(exportedRoot.result, receipt);
            assertEquals(restored.snapshotDistributedRun('sdk-distributed')?.commandLinks.find((link) => link.commandId === witness.commandId)?.phase, 'start');
            for (
                const [suffix, artifact] of [
                    ['native-snapshot.json', diskText],
                    ['native-disk-results.jsonl', diskRows],
                    ['native-fallback-results.jsonl', fallbackText],
                    ['native-distributed-control-run.json', bundle.files['control-run.json']]
                ]
            ) {
                await Deno.writeTextFile(`${witnessPath}.${suffix}`, artifact, { createNew: true });
            }
            console.log(
                `Native SDK disk lineage: input SHA256 ${await sha256(new TextEncoder().encode(text))}; snapshot SHA256 ${await sha256(
                    new TextEncoder().encode(diskText)
                )}; disk JSONL SHA256 ${await sha256(new TextEncoder().encode(diskRows))}`
            );
        }
        finally {
            await Deno.remove(storageDir, { recursive: true });
        }
    }
});

async function sha256(value: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertSdkCaptureReceipts(result: RallarBlackBoxTestResult, receipt: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>): void {
    const connections = toRallarBlackBoxCompositeResultFlatEntries([result]).filter((entry) => entry.kind === 'rtc.connect');
    assertEquals(connections.length, 4);
    assertEquals(new Set(connections.map((entry) => entry.path)).size, 4);
    for (const connection of connections) {
        assertEquals(toRtcCaptureReadout(decodeJsonValue(decodeRecord(connection.result.value).rtcCapture)).right, receipt);
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
    assertEquals(actual.invocation, input.invocation);
    assertSdkCaptureReceipts({ ...input.result, value: actual }, input.receipt);
}
