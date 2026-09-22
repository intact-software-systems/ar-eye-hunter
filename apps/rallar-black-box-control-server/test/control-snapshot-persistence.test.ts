import { assert, assertEquals } from '@std/assert';

import { createRallarBlackBoxControlService, type RallarBlackBoxControlService } from '../src/control-service.ts';
import { createControlSnapshotPersistence } from '../src/control-snapshot-persistence.ts';
import {
    assertRight,
    toCommandResultEnvelope,
    toControlServiceInput,
    toDistributedManifest,
    toFleetIdentity,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

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
    const [stageCommand] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toCommandResultEnvelope({
        runId: 'run-1',
        agentId: 'agent-1',
        command: stageCommand,
        ok: true
    }));
    return service;
}

async function restoreSnapshotText(
    snapshot: object
): Promise<Readonly<{ service: RallarBlackBoxControlService; warnings: readonly string[]; }>> {
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
        await createControlSnapshotPersistence({
            storageDir,
            retentionMaxRuns: 50,
            snapshotBounds: {},
            controlService: service,
            deleteRuns: () => undefined
        }).restore();
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
