import { decodeJsonWireText, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { arch, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { validateApiV1StateWriteEnvironment } from '../../../../../apps/api-v1/scripts/perf/validate-api-v1-state-write-environment.mjs';

const execFileAsync = promisify(execFile);
const PIN = 'postgres@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171';
const MANIFEST = 'bd2740e836cc644b8753c7a195483a3c26c121974be13be0c343f76635d2f2af';
const CONFIG = 'f961d097a9cedd37779baef1aab3fe87ef1c63b3b34d361f90a98ea5c9b77e56';
const FIXTURES = resolve('packages/tests/shared-server/performance/state-write/test-support/image-capture');
const CAPTURE = resolve('apps/api-v1/scripts/perf/capture-api-v1-state-write-environment.mjs');

interface CaptureNativeFacts {
    readonly archive: string;
    readonly exports: string;
    readonly containerText: string;
    readonly imageText: string;
    readonly containersText: string;
    readonly sqlText: string;
    readonly versionText: string;
    readonly maintenance: string;
    readonly exportFailure: boolean;
}

interface CaptureFixture {
    readonly directory: string;
    readonly nativeDirectory: string;
    readonly factsPath: string;
    readonly facts: CaptureNativeFacts;
    readonly preflight: string;
    readonly postflight: string;
}

describe('state-write environment capture native image provenance', () => {
    it('emits the original configuration identity from the reached containerd image', async () => {
        const fixture = await createCaptureFixture();
        try {
            await readCaptureStage({ fixture, stage: 'preflight' });
            const captured = decodeJsonWireText(await readFile(fixture.preflight, 'utf8'));
            expect(captured).toMatchObject({ record: { image_ref: PIN, image_id: `sha256:${CONFIG}` } });
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });
    it('completes a governed descriptor with the unchanged validator and no leftover export', async () => {
        const fixture = await createCaptureFixture();
        try {
            await readCaptureStage({ fixture, stage: 'preflight' });
            await expectTemporaryExportsRemoved({ fixture });
            const sidecar = decodeJsonWireText(await readFile(fixture.preflight, 'utf8'));
            expect(sidecar).toMatchObject({
                imageProof: {
                    containerImageId: PIN.slice(9),
                    nativeImageId: PIN.slice(9),
                    store: 'containerd',
                    manifestDigest: `sha256:${MANIFEST}`,
                    configBytes: 10152
                }
            });
            if (arch() === 'arm64') {
                await readCaptureStage({ fixture, stage: 'postflight' });
                expect(validateApiV1StateWriteEnvironment(await readFile(fixture.postflight, 'utf8'))).toEqual([]);
            }
            else {
                await expect(readCaptureStage({ fixture, stage: 'postflight' })).rejects.toThrow(/image and host architectures must match/);
            }
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it('preserves native-config identity for a classic export without a manifest descriptor', async () => {
        const fixture = await createCaptureFixture();
        try {
            const container = toFixtureObject({ value: decodeJsonWireText(fixture.facts.containerText) });
            const image = toFixtureObject({ value: decodeJsonWireText(fixture.facts.imageText) });
            await writeNativeFacts({
                fixture,
                facts: {
                    ...fixture.facts,
                    containerText: JSON.stringify({ ...container, Image: `sha256:${CONFIG}`, ImageManifestDescriptor: null }),
                    imageText: JSON.stringify({ ...image, Id: `sha256:${CONFIG}`, Descriptor: null })
                }
            });
            await writeFile(join(fixture.directory, 'image/manifest.json'), JSON.stringify([{ Config: `blobs/sha256/${CONFIG}` }]));
            await repackFixtureArchive({ fixture });
            await readCaptureStage({ fixture, stage: 'preflight' });
            expect(decodeJsonWireText(await readFile(fixture.preflight, 'utf8'))).toMatchObject({
                record: { image_id: `sha256:${CONFIG}` },
                imageProof: { store: 'classic' }
            });
            await expectTemporaryExportsRemoved({ fixture });
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it('rejects classic configuration bytes that differ from the actual native image identity', async () => {
        const fixture = await createCaptureFixture();
        try {
            const container = toFixtureObject({ value: decodeJsonWireText(fixture.facts.containerText) });
            const image = toFixtureObject({ value: decodeJsonWireText(fixture.facts.imageText) });
            const changedIdentity = `sha256:${'a'.repeat(64)}`;
            await writeNativeFacts({
                fixture,
                facts: {
                    ...fixture.facts,
                    containerText: JSON.stringify({ ...container, Image: changedIdentity, ImageManifestDescriptor: null }),
                    imageText: JSON.stringify({ ...image, Id: changedIdentity, Descriptor: null })
                }
            });
            await writeFile(join(fixture.directory, 'image/manifest.json'), JSON.stringify([{ Config: `blobs/sha256/${CONFIG}` }]));
            await repackFixtureArchive({ fixture });
            await expect(readCaptureStage({ fixture, stage: 'preflight' })).rejects.toThrow(
                /classic configuration bytes must match the native container image identity/
            );
            await expectTemporaryExportsRemoved({ fixture });
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it('rejects a different selected container manifest despite the valid configuration in the archive', async () => {
        const fixture = await createCaptureFixture();
        try {
            const container = toFixtureObject({ value: decodeJsonWireText(fixture.facts.containerText) });
            const descriptor = toFixtureObject({ value: container.ImageManifestDescriptor });
            await writeNativeFacts({
                fixture,
                facts: {
                    ...fixture.facts,
                    containerText: JSON.stringify({ ...container, ImageManifestDescriptor: { ...descriptor, digest: `sha256:${'a'.repeat(64)}` } })
                }
            });
            await expect(readCaptureStage({ fixture, stage: 'preflight' })).rejects.toThrow(/actual container selected manifest/);
            await expectTemporaryExportsRemoved({ fixture });
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it('rejects altered selected manifest bytes before reading an otherwise valid configuration', async () => {
        const fixture = await createCaptureFixture();
        try {
            await writeFile(join(fixture.directory, `image/blobs/sha256/${MANIFEST}`), 'tampered manifest');
            await repackFixtureArchive({ fixture });
            await expect(readCaptureStage({ fixture, stage: 'preflight' })).rejects.toThrow(/bytes do not match their descriptor/);
            await expectTemporaryExportsRemoved({ fixture });
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it('refuses a containerd image without its actual selected manifest', async () => {
        const fixture = await createCaptureFixture();
        try {
            const container = toFixtureObject({ value: decodeJsonWireText(fixture.facts.containerText) });
            await writeNativeFacts({ fixture, facts: { ...fixture.facts, containerText: JSON.stringify({ ...container, ImageManifestDescriptor: null }) } });
            await expect(readCaptureStage({ fixture, stage: 'preflight' })).rejects.toThrow(/requires the actual container manifest descriptor/);
            await expect(access(fixture.preflight)).rejects.toThrow();
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it.each(['link', 'oversized'] as const)('rejects %s identity metadata without extracting it', async (failure) => {
        const fixture = await createCaptureFixture();
        try {
            const metadata = join(fixture.directory, 'image/index.json');
            if (failure === 'link') {
                await rm(metadata);
                await symlink(`blobs/sha256/${MANIFEST}`, metadata);
            }
            else {
                await writeFile(metadata, ' '.repeat(65537));
            }
            await repackFixtureArchive({ fixture });
            await expect(readCaptureStage({ fixture, stage: 'preflight' })).rejects.toThrow();
            await expectTemporaryExportsRemoved({ fixture });
            await expect(access(fixture.preflight)).rejects.toThrow();
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it('rejects altered original configuration bytes', async () => {
        const fixture = await createCaptureFixture();
        try {
            await writeFile(join(fixture.directory, `image/blobs/sha256/${CONFIG}`), 'tampered');
            await repackFixtureArchive({ fixture });
            await expect(readCaptureStage({ fixture, stage: 'preflight' })).rejects.toThrow(/bytes do not match their descriptor/);
            await expectTemporaryExportsRemoved({ fixture });
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it('rejects the wrong configuration descriptor size after a valid manifest hash', async () => {
        const fixture = await createCaptureFixture();
        try {
            const manifest = toFixtureObject({ value: decodeJsonWireText(await readFile(join(FIXTURES, 'arm64-manifest.json'), 'utf8')) });
            await writeChangedManifest({ fixture, manifest: { ...manifest, config: { ...toFixtureObject({ value: manifest.config }), size: 10151 } } });
            await expect(readCaptureStage({ fixture, stage: 'preflight' })).rejects.toThrow(/bytes do not match their descriptor/);
            await expectTemporaryExportsRemoved({ fixture });
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it('rejects a hash-consistent configuration declaring the wrong platform', async () => {
        const fixture = await createCaptureFixture();
        try {
            const config = toFixtureObject({ value: decodeJsonWireText(await readFile(join(FIXTURES, 'arm64-config.json'), 'utf8')) });
            const changed = Buffer.from(JSON.stringify({ ...config, architecture: 'amd64' }));
            const digest = createHash('sha256').update(changed).digest('hex');
            await writeFile(join(fixture.directory, `image/blobs/sha256/${digest}`), changed);
            const manifest = toFixtureObject({ value: decodeJsonWireText(await readFile(join(FIXTURES, 'arm64-manifest.json'), 'utf8')) });
            await writeChangedManifest({
                fixture,
                manifest: { ...manifest, config: { ...toFixtureObject({ value: manifest.config }), digest: `sha256:${digest}`, size: changed.length } }
            });
            await expect(readCaptureStage({ fixture, stage: 'preflight' })).rejects.toThrow(/configuration bytes must declare the native selected platform/);
            await expectTemporaryExportsRemoved({ fixture });
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it.each(['missing', 'duplicate', 'ambiguous', 'malformed'] as const)('rejects %s image metadata and removes temporary exports', async (failure) => {
        const fixture = await createCaptureFixture();
        try {
            if (failure === 'missing') {
                await rm(join(fixture.directory, `image/blobs/sha256/${CONFIG}`));
                await repackFixtureArchive({ fixture });
            }
            else if (failure === 'duplicate') {
                await execFileAsync('tar', ['-rf', fixture.facts.archive, '-C', join(fixture.directory, 'image'), 'index.json']);
            }
            else if (failure === 'ambiguous') {
                const index = toFixtureObject({ value: decodeJsonWireText(await readFile(join(fixture.directory, 'image/index.json'), 'utf8')) });
                if (!Array.isArray(index.manifests)) {
                    throw new TypeError('fixture index must have descriptors');
                }
                await writeFile(join(fixture.directory, 'image/index.json'), JSON.stringify({ ...index, manifests: [...index.manifests, ...index.manifests] }));
                await repackFixtureArchive({ fixture });
            }
            else {
                await writeFile(join(fixture.directory, 'image/index.json'), '{');
                await repackFixtureArchive({ fixture });
            }
            await expect(readCaptureStage({ fixture, stage: 'preflight' })).rejects.toThrow();
            await expectTemporaryExportsRemoved({ fixture });
            await expect(access(fixture.preflight)).rejects.toThrow();
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it.each(['export', 'reader'] as const)('cleans temporary files after native %s failure', async (failure) => {
        const fixture = await createCaptureFixture();
        try {
            if (failure === 'reader') {
                await writeFile(join(fixture.nativeDirectory, 'tar'), '#!/usr/bin/env node\nthrow new Error("native reader failed");\n', { mode: 0o755 });
            }
            await writeNativeFacts({ fixture, facts: { ...fixture.facts, exportFailure: failure === 'export' } });
            await expect(readCaptureStage({ fixture, stage: 'preflight' })).rejects.toThrow(new RegExp(`native ${failure} failed`));
            await expectTemporaryExportsRemoved({ fixture });
            await expect(access(fixture.preflight)).rejects.toThrow();
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it('retains the changed-container postflight rejection', async () => {
        const fixture = await createCaptureFixture();
        try {
            await readCaptureStage({ fixture, stage: 'preflight' });
            const container = toFixtureObject({ value: decodeJsonWireText(fixture.facts.containerText) });
            await writeNativeFacts({ fixture, facts: { ...fixture.facts, containerText: JSON.stringify({ ...container, Id: 'replacement-container' }) } });
            await expect(readCaptureStage({ fixture, stage: 'postflight' })).rejects.toThrow(/container identity changed/);
            await expect(access(fixture.postflight)).rejects.toThrow();
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it('retains dirty preflight rejection', async () => {
        const fixture = await createCaptureFixture();
        try {
            await writeNativeFacts({
                fixture,
                facts: { ...fixture.facts, sqlText: fixture.facts.sqlText.replace('preflight_app_data_store_rows=0', 'preflight_app_data_store_rows=1') }
            });
            await expect(readCaptureStage({ fixture, stage: 'preflight' })).rejects.toThrow(/preflight database is not empty/);
            await expectTemporaryExportsRemoved({ fixture });
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it('retains maintenance rejection after clean preflight', async () => {
        const fixture = await createCaptureFixture();
        try {
            await readCaptureStage({ fixture, stage: 'preflight' });
            await writeNativeFacts({ fixture, facts: { ...fixture.facts, maintenance: '1' } });
            await expect(readCaptureStage({ fixture, stage: 'postflight' })).rejects.toThrow(/postflight_automatic_maintenance_count must equal 0/);
            await expect(access(fixture.postflight)).rejects.toThrow();
        }
        finally {
            await rm(fixture.directory, { recursive: true, force: true });
        }
    });
});

async function createCaptureFixture(): Promise<CaptureFixture> {
    const directory = await mkdtemp(join(tmpdir(), 'rallar-image-capture-'));
    try {
        const nativeDirectory = join(directory, 'native');
        await mkdir(nativeDirectory);
        for (const command of ['docker', 'npm', 'deno', 'ps']) {
            await writeFile(join(nativeDirectory, command), await readFile(join(FIXTURES, 'native-capture-command.mjs')), { mode: 0o755 });
        }
        const archive = await writeCaptureArchive({ directory });
        const facts = createNativeFacts({ directory, archive });
        const factsPath = join(directory, 'facts.json');
        await writeFile(factsPath, JSON.stringify(facts));
        return { directory, nativeDirectory, factsPath, facts, preflight: join(directory, 'preflight.json'), postflight: join(directory, 'environment.txt') };
    }
    catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

async function writeCaptureArchive({ directory }: { readonly directory: string; }): Promise<string> {
    const content = join(directory, 'image');
    await mkdir(join(content, 'blobs/sha256'), { recursive: true });
    await copyFile(join(FIXTURES, 'arm64-manifest.json'), join(content, `blobs/sha256/${MANIFEST}`));
    await copyFile(join(FIXTURES, 'arm64-config.json'), join(content, `blobs/sha256/${CONFIG}`));
    await writeFile(
        join(content, 'index.json'),
        JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.index.v1+json',
            manifests: [{
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                digest: `sha256:${MANIFEST}`,
                size: 3630,
                platform: { os: 'linux', architecture: 'arm64', variant: 'v8' }
            }]
        })
    );
    const archive = join(directory, 'image.tar');
    await execFileAsync('tar', ['-cf', archive, '-C', content, 'index.json', 'blobs']);
    return archive;
}

function createNativeFacts({ directory, archive }: { readonly directory: string; readonly archive: string; }): CaptureNativeFacts {
    return {
        archive,
        exports: join(directory, 'exports.txt'),
        containersText: 'isolated-perf',
        versionText: '29.6.2',
        maintenance: '0',
        exportFailure: false,
        containerText: JSON.stringify({
            Id: 'container-one',
            Image: PIN.slice('postgres@'.length),
            ImageManifestDescriptor: {
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                digest: `sha256:${MANIFEST}`,
                size: 3630,
                platform: { os: 'linux', architecture: 'arm64', variant: 'v8' }
            },
            Platform: 'linux',
            Config: { Cmd: ['postgres', '-c', 'autovacuum=off'] },
            HostConfig: { ShmSize: 268435456, Memory: 4294967296, MemorySwap: 4294967296, NanoCpus: 4000000000, CpuPeriod: 0, CpuQuota: 0, CpusetCpus: '' },
            RestartCount: 0
        }),
        imageText: JSON.stringify({
            Id: PIN.slice('postgres@'.length),
            RepoDigests: [PIN],
            Descriptor: { mediaType: 'application/vnd.oci.image.index.v1+json', digest: PIN.slice('postgres@'.length), size: 10237 },
            Architecture: 'arm64',
            Os: 'linux',
            Config: { Entrypoint: ['docker-entrypoint.sh'] }
        }),
        sqlText: [
            'server_version=16.14',
            'autovacuum=off',
            'track_counts=on',
            'shared_buffers=16384',
            'work_mem=4096',
            'maintenance_work_mem=65536',
            'effective_cache_size=524288',
            'random_page_cost=4',
            'effective_io_concurrency=1',
            'synchronous_commit=on',
            'fsync=on',
            'full_page_writes=on',
            'max_wal_size=1024',
            'checkpoint_timeout=300',
            'jit=on',
            'max_parallel_workers_per_gather=2',
            ...['app_data_store', 'client_state_events', 'group_state_events', 'resource_inbox', 'resource_inbox_results', 'runtime_state_store'].map((table) =>
                `preflight_${table}_rows=0`
            )
        ].join('\n')
    };
}

async function readCaptureStage({ fixture, stage }: { readonly fixture: CaptureFixture; readonly stage: 'preflight' | 'postflight'; }): Promise<void> {
    await execFileAsync(process.execPath, [
        CAPTURE,
        '--stage',
        stage,
        '--container',
        'isolated-perf',
        '--database-url',
        'postgres://fixture:fixture@localhost/fixture',
        '--preflight',
        fixture.preflight,
        '--out',
        stage === 'preflight' ? fixture.preflight : fixture.postflight
    ], {
        timeout: 15_000,
        env: { ...process.env, PATH: `${fixture.nativeDirectory}:${process.env.PATH}`, RALLAR_CAPTURE_FIXTURE: fixture.factsPath, TMPDIR: fixture.directory }
    });
}

async function writeNativeFacts({ fixture, facts }: { readonly fixture: CaptureFixture; readonly facts: CaptureNativeFacts; }): Promise<void> {
    await writeFile(fixture.factsPath, JSON.stringify(facts));
}

async function repackFixtureArchive({ fixture }: { readonly fixture: CaptureFixture; }): Promise<void> {
    await execFileAsync('tar', ['-cf', fixture.facts.archive, '-C', join(fixture.directory, 'image'), ...await readdir(join(fixture.directory, 'image'))]);
}

function toFixtureObject({ value }: { readonly value: JsonWireValue; }): JsonWireObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('native fixture metadata must be an object');
    }
    return value as JsonWireObject;
}

async function writeChangedManifest({ fixture, manifest }: { readonly fixture: CaptureFixture; readonly manifest: JsonWireObject; }): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(manifest));
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(fixture.directory, `image/blobs/sha256/${digest}`), bytes);
    const container = toFixtureObject({ value: decodeJsonWireText(fixture.facts.containerText) });
    const selected = { ...toFixtureObject({ value: container.ImageManifestDescriptor }), digest: `sha256:${digest}`, size: bytes.length };
    await writeNativeFacts({ fixture, facts: { ...fixture.facts, containerText: JSON.stringify({ ...container, ImageManifestDescriptor: selected }) } });
    await writeFile(
        join(fixture.directory, 'image/index.json'),
        JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [selected] })
    );
    await repackFixtureArchive({ fixture });
}

async function expectTemporaryExportsRemoved({ fixture }: { readonly fixture: CaptureFixture; }): Promise<void> {
    const paths = (await readFile(fixture.facts.exports, 'utf8')).trim().split('\n');
    for (const path of paths) {
        await expect(access(path)).rejects.toThrow();
        await expect(access(dirname(path))).rejects.toThrow();
    }
}
