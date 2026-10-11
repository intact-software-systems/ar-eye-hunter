import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStateWriteBenchmarkArtifact } from '../../../../../apps/api-v1/scripts/perf/state-write/api-v1-state-write-benchmark-artifact.ts';
import { parseBenchmarkOptions } from '../../../../../apps/api-v1/scripts/perf/state-write/api-v1-state-write-benchmark-options.ts';
import { writeStateWriteBenchmarkOutput } from '../../../../../apps/api-v1/scripts/perf/state-write/state-write-benchmark-output.ts';
import type { StateWriteDiagnosticPhase } from '../../../../../apps/api-v1/scripts/perf/state-write/state-write-diagnostic-projection.ts';
import {
    StateWriteDiagnosticWriter,
    type StateWriteDiagnosticFilePort
} from '../../../../../apps/api-v1/scripts/perf/state-write/state-write-diagnostic-writer.ts';

const directories: string[] = [];
const budget = { eventsPerPhase: 2, bytesPerPhase: 4096, bytesPerRun: 8192 };
const phase: StateWriteDiagnosticPhase = {
    workload: 'shared',
    phase: 'measured',
    runIndex: 0,
    scope: { applicationId: 'private', workspaceId: 'private' },
    groupCount: 5,
    serviceIds: ['private-a', 'private-b'],
    performanceTimeOriginEpochMs: 1000,
    startedAtMonotonicMs: 1,
    endedAtMonotonicMs: 2,
    commands: [],
    boundaries: [],
    timingEvents: [],
    releases: [],
    outcome: 'completed'
};

async function createDirectory(): Promise<string> {
    const parent = await files.mkdtemp(join(tmpdir(), 'state-write-diagnostic-'));
    directories.push(parent);
    return join(parent, 'capture');
}

function createArtifact() {
    return createStateWriteBenchmarkArtifact({
        generatedAt: '2026-10-11T00:00:00Z',
        gitIdentity: { commit: 'source', tree: 'tree' },
        options: parseBenchmarkOptions([]),
        regressionReasons: [],
        workloads: []
    });
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => files.rm(directory, { recursive: true, force: true })));
});

describe('state-write diagnostic file lifecycle', () => {
    it('writes enabled phases and a completeness receipt, while disabled capture touches no files', async () => {
        const directory = await createDirectory();
        const writer = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await writer.start(join(dirname(directory), 'canonical.json'));
        await writer.writePhase(phase);
        expect(await writer.finish(true)).toMatchObject({ kind: 'complete', phases: 1 });
        expect(JSON.parse(await files.readFile(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ kind: 'complete', phases: 1 });
        expect(await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8')).toContain('"record":"completeness"');
        const disabled = new StateWriteDiagnosticWriter({ kind: 'disabled' }, budget, {
            rename: files.rename,
            realpath: files.realpath,
            lstat: files.lstat,
            mkdir: async () => {
                throw new Error('disabled file access');
            },
            open: async () => {
                throw new Error('disabled file access');
            }
        });
        await disabled.start('unused-canonical.json');
        await disabled.writePhase(phase);
        expect(await disabled.finish(true)).toMatchObject({ kind: 'disabled' });
    });

    it('preserves colliding evidence and reports reservation failure', async () => {
        const directory = await createDirectory();
        await files.mkdir(directory);
        await files.writeFile(join(directory, 'sentinel'), 'previous evidence');
        const writer = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await writer.start(join(dirname(directory), 'canonical.json'));
        await writer.writePhase(phase);
        expect(await writer.finish(true)).toMatchObject({ kind: 'incomplete', stage: 'reservation' });
        expect(await files.readdir(directory)).toEqual(['sentinel']);
        expect(await files.readFile(join(directory, 'sentinel'), 'utf8')).toBe('previous evidence');
    });

    it('retains partial bytes, closes the failed file and never issues a complete receipt', async () => {
        const directory = await createDirectory();
        let failedHandle: Awaited<ReturnType<typeof files.open>> | undefined;
        const port: StateWriteDiagnosticFilePort = {
            mkdir: files.mkdir,
            rename: files.rename,
            realpath: files.realpath,
            lstat: files.lstat,
            open: async (...args: Parameters<typeof files.open>) => {
                const handle = await files.open(...args);
                if (String(args[0]).endsWith('phase-0.ndjson.partial')) {
                    failedHandle = handle;
                    handle.writeFile = async () => {
                        await handle.write('partial-safe-evidence');
                        throw new Error('PRIVATE-write-failure');
                    };
                }
                return handle;
            }
        };
        const writer = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, port);
        await writer.start(join(dirname(directory), 'canonical.json'));
        await writer.writePhase(phase);
        expect(await writer.finish(true)).toMatchObject({ kind: 'incomplete', stage: 'phase-write' });
        expect(await files.readFile(join(directory, 'phase-0.ndjson.partial'), 'utf8')).toBe('partial-safe-evidence');
        expect(failedHandle?.fd).toBe(-1);
        const receipt = await files.readFile(join(directory, 'receipt.json'), 'utf8');
        expect(receipt).toContain('incomplete');
        expect(receipt).not.toContain('PRIVATE');
    });

    it('does not publish a successful completeness receipt when its close fails', async () => {
        const directory = await createDirectory();
        const port: StateWriteDiagnosticFilePort = {
            mkdir: files.mkdir,
            rename: files.rename,
            realpath: files.realpath,
            lstat: files.lstat,
            open: async (...args: Parameters<typeof files.open>) => {
                const handle = await files.open(...args);
                if (String(args[0]).includes('receipt')) {
                    const close = handle.close.bind(handle);
                    handle.close = async () => {
                        await close();
                        throw new Error('PRIVATE-close');
                    };
                }
                return handle;
            }
        };
        const writer = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, port);
        await writer.start(join(dirname(directory), 'canonical.json'));
        await writer.writePhase(phase);
        expect(await writer.finish(true)).toMatchObject({ kind: 'incomplete', stage: 'receipt' });
        await expect(files.access(join(directory, 'receipt.json'))).rejects.toThrow();
    });

    it('never leaves a successful canonical receipt after publication fails', async () => {
        const directory = await createDirectory();
        const writer = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, {
            ...files,
            rename: async (source, destination) => {
                if (String(destination).includes('receipt')) {
                    throw new Error('PRIVATE-publish');
                }
                await files.rename(source, destination);
            }
        });
        await writer.start(join(dirname(directory), 'canonical.json'));
        await writer.writePhase(phase);
        const status = await writer.finish(true);
        expect(status.kind).toBe('incomplete');
        expect(await files.readFile(join(directory, 'receipt.json'), 'utf8')).not.toContain('"kind":"complete"');
    });

    it('still publishes the exact canonical v6 artifact when supplemental output fails', async () => {
        const directory = await createDirectory();
        await files.mkdir(directory);
        const diagnostics = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await diagnostics.start(join(dirname(directory), 'canonical.json'));
        const artifact = createStateWriteBenchmarkArtifact({
            generatedAt: '2026-10-11T00:00:00Z',
            gitIdentity: { commit: 'source', tree: 'tree' },
            options: parseBenchmarkOptions([`--diagnostics-dir=${directory}`]),
            regressionReasons: [],
            workloads: []
        });
        const destination = join(dirname(directory), 'canonical.json');
        expect(await writeStateWriteBenchmarkOutput({ artifact, destination, diagnostics })).toMatchObject({ kind: 'incomplete', stage: 'reservation' });
        const serialized = await files.readFile(destination, 'utf8');
        expect(JSON.parse(serialized)).toEqual(artifact);
        expect(serialized).toContain('rallar.api-v1.state-write.v6');
        expect(serialized).not.toContain('diagnostics');
    });

    it('reports invalid observed boundaries as incomplete projection, without mislabeling capacity', async () => {
        const directory = await createDirectory();
        const writer = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await writer.start(join(dirname(directory), 'canonical.json'));
        await writer.writePhase({ ...phase, endedAtMonotonicMs: 0 });
        expect(await writer.finish(true)).toMatchObject({ kind: 'incomplete', stage: 'projection' });
        const receipt = JSON.parse(await files.readFile(join(directory, 'receipt.json'), 'utf8'));
        expect(receipt).toMatchObject({ kind: 'incomplete', stage: 'projection' });
    });

    it('isolates projection failure without exposing the rejected identity', async () => {
        const directory = await createDirectory();
        const writer = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await writer.start(join(dirname(directory), 'canonical.json'));
        await writer.writePhase({ ...phase, commands: [{ commandId: 'PRIVATE-invalid-id', kind: 'config', stackIndex: 0, status: 'accepted' }] });
        expect(await writer.finish(false)).toMatchObject({ kind: 'incomplete', stage: 'projection' });
        expect(await files.readFile(join(directory, 'receipt.json'), 'utf8')).not.toContain('PRIVATE');
    });

    it('publishes an incomplete receipt when the benchmark operation did not complete', async () => {
        const directory = await createDirectory();
        const writer = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await writer.start(join(dirname(directory), 'canonical.json'));
        expect(await writer.finish(false)).toMatchObject({ kind: 'incomplete', stage: 'operation' });
        expect(JSON.parse(await files.readFile(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ kind: 'incomplete', stage: 'operation' });
    });

    it('bounds all retained phase and receipt bytes across a diagnostic run', async () => {
        const limitedDirectory = await createDirectory();
        const limited = new StateWriteDiagnosticWriter({ kind: 'enabled', directory: limitedDirectory }, { ...budget, bytesPerRun: 1500 }, files);
        await limited.start(join(dirname(limitedDirectory), 'canonical.json'));
        await limited.writePhase(phase);
        await limited.writePhase(phase);
        expect(await limited.finish(true)).toMatchObject({ kind: 'incomplete' });
        const lengths = await Promise.all((await files.readdir(limitedDirectory)).map(async (name) => (await files.stat(join(limitedDirectory, name))).size));
        expect(lengths.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(1500);
    });

    it.each(['phase-0.ndjson', 'receipt.json', 'receipt.json.partial', ''])(
        'rejects a colliding canonical destination %s after a successful phase without overwriting evidence',
        async (name) => {
            const directory = await createDirectory();
            const diagnostics = new StateWriteDiagnosticWriter({ kind: 'enabled', directory: relative(process.cwd(), directory) }, budget, files);
            await diagnostics.start(join(dirname(directory), 'canonical.json'));
            await diagnostics.writePhase(phase);
            const before = await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8');
            await expect(writeStateWriteBenchmarkOutput({ artifact: createArtifact(), destination: join(directory, name), diagnostics }))
                .rejects.toThrow('Canonical output and diagnostic directory must be disjoint');
            expect(await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8')).toBe(before);
            expect(JSON.parse(await files.readFile(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ kind: 'incomplete', stage: 'operation' });
        }
    );

    it('preserves an actual retained partial phase when canonical publication targets that partial path', async () => {
        const directory = await createDirectory();
        const diagnostics = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, {
            ...files,
            rename: async (source, destination) => {
                if (String(destination).endsWith('phase-1.ndjson')) {
                    throw new Error('controlled phase publication failure');
                }
                await files.rename(source, destination);
            }
        });
        await diagnostics.start(join(dirname(directory), 'canonical.json'));
        await diagnostics.writePhase(phase);
        await diagnostics.writePhase(phase);
        const destination = join(directory, 'phase-1.ndjson.partial');
        const before = await files.readFile(destination, 'utf8');
        await expect(writeStateWriteBenchmarkOutput({ artifact: createArtifact(), destination, diagnostics }))
            .rejects.toThrow('Canonical output and diagnostic directory must be disjoint');
        expect(await files.readFile(destination, 'utf8')).toBe(before);
        expect(JSON.parse(await files.readFile(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ kind: 'incomplete', stage: 'phase-write' });
    });

    it('preserves the canonical filesystem failure and records incomplete diagnostics', async () => {
        const directory = await createDirectory();
        const diagnostics = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await diagnostics.start(join(dirname(directory), 'canonical.json'));
        await diagnostics.writePhase(phase);
        const destination = join(dirname(directory), 'canonical.json');
        await files.mkdir(destination);
        await expect(writeStateWriteBenchmarkOutput({ artifact: createArtifact(), destination, diagnostics })).rejects.toMatchObject({ code: 'EISDIR' });
        expect(JSON.parse(await files.readFile(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ kind: 'incomplete', stage: 'operation' });
    });

    it('publishes disjoint canonical output and complete diagnostics using normalized destinations', async () => {
        const directory = await createDirectory();
        const diagnostics = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await diagnostics.start(join(dirname(directory), 'canonical.json'));
        await diagnostics.writePhase(phase);
        const before = await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8');
        const destination = join(dirname(directory), 'canonical.json');
        const artifact = createArtifact();
        expect(await writeStateWriteBenchmarkOutput({ artifact, destination: relative(process.cwd(), destination), diagnostics })).toMatchObject({
            kind: 'complete'
        });
        expect(JSON.parse(await files.readFile(destination, 'utf8'))).toEqual(artifact);
        expect(await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8')).toBe(before);
        expect(JSON.parse(await files.readFile(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ kind: 'complete' });
    });

    it('rejects existing parent aliases before reserving the fresh diagnostic directory', async () => {
        const directory = await createDirectory();
        const parent = dirname(directory);
        const alias = join(parent, 'parent-alias');
        await files.symlink(parent, alias, 'dir');
        const diagnostics = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await expect(diagnostics.start(join(alias, 'capture', 'phase-0.ndjson')))
            .rejects.toThrow('Canonical output and diagnostic directory must be disjoint');
        await expect(files.access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each(['phase-0.ndjson', 'receipt.json', 'receipt.json.partial', ''])(
        'rejects realpath aliases of diagnostic %s at the actual publication boundary',
        async (name) => {
            const directory = await createDirectory();
            const diagnostics = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
            await diagnostics.start(join(dirname(directory), 'canonical.json'));
            await diagnostics.writePhase(phase);
            const alias = join(dirname(directory), 'capture-alias');
            await files.symlink(directory, alias, 'dir');
            const before = await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8');
            await expect(writeStateWriteBenchmarkOutput({ artifact: createArtifact(), destination: join(alias, name), diagnostics }))
                .rejects.toThrow('Canonical output and diagnostic directory must be disjoint');
            expect(await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8')).toBe(before);
            expect(JSON.parse(await files.readFile(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ kind: 'incomplete' });
        }
    );
    it('rejects an unresolved canonical symlink into the receipt namespace without publishing complete diagnostics', async () => {
        const directory = await createDirectory();
        const destination = join(dirname(directory), 'canonical-link.json');
        const diagnostics = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await diagnostics.start(destination);
        await diagnostics.writePhase(phase);
        const before = await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8');
        await files.symlink(join(directory, 'receipt.json.partial'), destination);
        await expect(writeStateWriteBenchmarkOutput({ artifact: createArtifact(), destination, diagnostics }))
            .rejects.toThrow('Unable to resolve benchmark output destinations');
        expect(await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8')).toBe(before);
        expect(JSON.parse(await files.readFile(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ kind: 'incomplete' });
    });

    it('resolves parent traversal after an existing symlink before allowing publication', async () => {
        const directory = await createDirectory();
        const parent = dirname(directory);
        const target = join(directory, 'nested');
        const alias = join(parent, 'nested-alias');
        const diagnostics = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await diagnostics.start(join(parent, 'canonical.json'));
        await diagnostics.writePhase(phase);
        await files.mkdir(target);
        await files.symlink(target, alias, 'dir');
        const destination = `${alias}/../phase-0.ndjson`;
        const before = await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8');
        await expect(writeStateWriteBenchmarkOutput({ artifact: createArtifact(), destination, diagnostics }))
            .rejects.toThrow('Canonical output and diagnostic directory must be disjoint');
        expect(await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8')).toBe(before);
        expect(JSON.parse(await files.readFile(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ kind: 'incomplete' });
    });

    it('recognizes the host realpath spelling of an already retained phase', async () => {
        const directory = await createDirectory();
        const diagnostics = new StateWriteDiagnosticWriter({ kind: 'enabled', directory }, budget, files);
        await diagnostics.start(join(dirname(directory), 'canonical.json'));
        await diagnostics.writePhase(phase);
        const before = await files.readFile(join(directory, 'phase-0.ndjson'), 'utf8');
        const destination = join(await files.realpath(directory), 'phase-0.ndjson');
        await expect(writeStateWriteBenchmarkOutput({ artifact: createArtifact(), destination, diagnostics }))
            .rejects.toThrow('Canonical output and diagnostic directory must be disjoint');
        expect(await files.readFile(destination, 'utf8')).toBe(before);
        expect(JSON.parse(await files.readFile(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ kind: 'incomplete' });
    });
});
