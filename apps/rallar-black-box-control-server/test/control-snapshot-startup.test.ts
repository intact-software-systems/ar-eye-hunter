import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('rejected retained manifest refuses startup without replacing history, and a valid backup restores service', { timeout: 20_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'control-history-startup-'));
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
        await writeFile(snapshotPath, rejectedText, 'utf8');
        await writeFile(artifactPath, '{"retained":true}', 'utf8');
        const failure = await readStartupFailure(storageDir);
        expect(await readFile(snapshotPath, 'utf8')).toEqual(rejectedText);
        expect(await readFile(artifactPath, 'utf8')).toEqual('{"retained":true}');
        assert(failure !== undefined);
        assert(failure.message.includes('distributedRuns[0]: manifest is not a valid distributed run manifest'));

        await copyFile(snapshotPath, `${snapshotPath}.rejected`);
        await writeFile(snapshotPath, validBackup, 'utf8');
        const recovered = await startControlServer({ RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN, RALLAR_BLACK_BOX_STORAGE_DIR: storageDir });
        let socket: WebSocket | undefined;
        try {
            const run = await getJson<{ runId: string; }>(recovered.baseUrl, '/runs/run-1');
            expect(run.runId).toEqual('run-1');
            const distributed = await getJson<{ distributedRunId: string; }>(recovered.baseUrl, '/distributed-runs/dist-1');
            expect(distributed.distributedRunId).toEqual('dist-1');
            socket = await registerAgent(recovered.baseUrl, 'new-run', 'new-agent');
            await waitForPersistedSnapshot(storageDir, 'new-run');
        }
        finally {
            socket?.close();
            await recovered.stop();
        }
        const restarted = await startControlServer({ RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN, RALLAR_BLACK_BOX_STORAGE_DIR: storageDir });
        try {
            expect((await getJson<{ runId: string; }>(restarted.baseUrl, '/runs/run-1')).runId).toEqual('run-1');
            expect((await getJson<{ runId: string; }>(restarted.baseUrl, '/runs/new-run')).runId).toEqual('new-run');
            expect(await readFile(`${snapshotPath}.rejected`, 'utf8')).toEqual(rejectedText);
            expect(await readFile(artifactPath, 'utf8')).toEqual('{"retained":true}');
        }
        finally {
            await restarted.stop();
        }
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('malformed snapshot JSON refuses startup and preserves its exact bytes', { timeout: 20_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'control-history-json-'));
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    const malformed = '{"snapshot":';
    try {
        await writeFile(snapshotPath, malformed, 'utf8');
        const failure = await readStartupFailure(storageDir);
        expect(await readFile(snapshotPath, 'utf8')).toEqual(malformed);
        assert(failure !== undefined);
        assert(failure.message.includes('Could not restore control snapshot'));
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('an unreadable existing snapshot path refuses startup instead of treating it as absent', { timeout: 20_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'control-history-read-'));
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    try {
        await mkdir(snapshotPath);
        await writeFile(`${snapshotPath}/preserved`, 'retained', 'utf8');
        const failure = await readStartupFailure(storageDir);
        assert(failure !== undefined);
        assert(failure.message.includes('Could not restore control snapshot'));
        expect(await readFile(`${snapshotPath}/preserved`, 'utf8')).toEqual('retained');
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('a dangling snapshot symlink refuses startup and remains available for operator recovery', { timeout: 20_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'control-history-symlink-'));
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    const target = `${storageDir}/unavailable-snapshot.json`;
    try {
        await symlink(target, snapshotPath);
        const failure = await readStartupFailure(storageDir);
        assert(failure !== undefined);
        assert(failure.message.includes('Could not restore control snapshot'));
        expect(await readlink(snapshotPath)).toEqual(target);
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
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
