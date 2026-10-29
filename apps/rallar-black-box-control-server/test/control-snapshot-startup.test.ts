import { assert, assertEquals } from '@std/assert';

import { toError } from '@shared/resilience/to-error.ts';

import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import { registerAgent, waitForPersistedSnapshot } from './support/control-api-test-agent.ts';
import {
    ADMIN_TOKEN,
    getJson,
    startControlServer
} from './support/control-api-test-server.ts';
import {
    assertRight,
    toControlServiceInput,
    toDistributedManifest,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

Deno.test('rejected retained manifest refuses startup without replacing history, and a valid backup restores service', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'control-history-startup-' });
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    const artifactPath = `${storageDir}/retained-artifact.json`;
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.createDistributedRun(toDistributedManifest()));
    const validBackup = JSON.stringify({ schemaVersion: 1, savedAtEpochMs: 1_000, snapshot: service.snapshotForPersistence({}) });
    const rejected = JSON.parse(validBackup);
    rejected.snapshot.distributedRuns[0].manifest.purpose = 'unsupported retained property';
    const rejectedText = JSON.stringify(rejected);
    try {
        await Deno.writeTextFile(snapshotPath, rejectedText);
        await Deno.writeTextFile(artifactPath, '{"retained":true}');
        const failure = await readStartupFailure(storageDir);
        assertEquals(await Deno.readTextFile(snapshotPath), rejectedText);
        assertEquals(await Deno.readTextFile(artifactPath), '{"retained":true}');
        assert(failure !== undefined, 'A rejected snapshot must prevent the HTTP server from becoming healthy.');
        assert(failure.message.includes('distributedRuns[0]: manifest is not a valid distributed run manifest'));

        await Deno.copyFile(snapshotPath, `${snapshotPath}.rejected`);
        await Deno.writeTextFile(snapshotPath, validBackup);
        const recovered = await startControlServer({ RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN, RALLAR_BLACK_BOX_STORAGE_DIR: storageDir });
        let socket: WebSocket | undefined;
        try {
            const run = await getJson<{ runId: string; }>(recovered.baseUrl, '/runs/run-1');
            assertEquals(run.runId, 'run-1');
            const distributed = await getJson<{ distributedRunId: string; }>(recovered.baseUrl, '/distributed-runs/dist-1');
            assertEquals(distributed.distributedRunId, 'dist-1');
            socket = await registerAgent(recovered.baseUrl, 'new-run', 'new-agent');
            await waitForPersistedSnapshot(storageDir, 'new-run');
        }
        finally {
            socket?.close();
            await recovered.stop();
        }
        const restarted = await startControlServer({ RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN, RALLAR_BLACK_BOX_STORAGE_DIR: storageDir });
        try {
            assertEquals((await getJson<{ runId: string; }>(restarted.baseUrl, '/runs/run-1')).runId, 'run-1');
            assertEquals((await getJson<{ runId: string; }>(restarted.baseUrl, '/runs/new-run')).runId, 'new-run');
            assertEquals(await Deno.readTextFile(`${snapshotPath}.rejected`), rejectedText);
            assertEquals(await Deno.readTextFile(artifactPath), '{"retained":true}');
        }
        finally {
            await restarted.stop();
        }
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('malformed snapshot JSON refuses startup and preserves its exact bytes', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'control-history-json-' });
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    const malformed = '{"snapshot":';
    try {
        await Deno.writeTextFile(snapshotPath, malformed);
        const failure = await readStartupFailure(storageDir);
        assertEquals(await Deno.readTextFile(snapshotPath), malformed);
        assert(failure !== undefined, 'Malformed JSON must prevent startup.');
        assert(failure.message.includes('Could not restore control snapshot'));
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('an unreadable existing snapshot path refuses startup instead of treating it as absent', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'control-history-read-' });
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    try {
        await Deno.mkdir(snapshotPath);
        await Deno.writeTextFile(`${snapshotPath}/preserved`, 'retained');
        const failure = await readStartupFailure(storageDir);
        assert(failure !== undefined, 'An existing non-readable snapshot must prevent startup.');
        assert(failure.message.includes('Could not restore control snapshot'));
        assertEquals(await Deno.readTextFile(`${snapshotPath}/preserved`), 'retained');
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('a dangling snapshot symlink refuses startup and remains available for operator recovery', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'control-history-symlink-' });
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    const target = `${storageDir}/unavailable-snapshot.json`;
    try {
        await Deno.symlink(target, snapshotPath);
        const failure = await readStartupFailure(storageDir);
        assert(failure !== undefined, 'An unavailable existing snapshot must not become a fresh store.');
        assert(failure.message.includes('Could not restore control snapshot'));
        assertEquals(await Deno.readLink(snapshotPath), target);
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

async function readStartupFailure(storageDir: string): Promise<Error | undefined> {
    try {
        const server = await startControlServer({ RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN, RALLAR_BLACK_BOX_STORAGE_DIR: storageDir });
        await server.stop();
        return undefined;
    }
    catch (error) {
        return toError(error);
    }
}
