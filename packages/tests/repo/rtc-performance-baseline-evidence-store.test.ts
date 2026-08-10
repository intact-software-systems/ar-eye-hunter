import { describe, expect, it } from 'vitest';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRtcBaselineFileStore } from '../../../scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts';

const unconfinedFailure = {
  ok: false,
  issues: [
    {
      path: '$.path',
      code: 'unconfined-path',
      message: 'Artifact path must remain beneath the baseline directory.',
    },
  ],
};
const symlinkFailure = {
  ok: false,
  issues: [
    {
      path: '$.path',
      code: 'symlink-component',
      message: 'Artifact paths may not contain symlink components.',
    },
  ],
};
const baselineId = '20260807-0123456789ab-e1-local';
const baselinePath = `/evidence/${baselineId}`;
function nodeEntryKind(value: { isSymbolicLink(): boolean; isDirectory(): boolean }) {
  if (value.isSymbolicLink()) return 'symlink' as const;
  return value.isDirectory() ? ('directory' as const) : ('file' as const);
}
function createNodePort() {
  return {
    async inspectPath(path: string) {
      try {
        const value = await lstat(path);
        return { kind: nodeEntryKind(value) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    createDirectory: (path: string, options: { recursive: boolean }) =>
      mkdir(path, options).then(() => undefined),
    writeFileCreateNew: (path: string, bytes: Uint8Array) => writeFile(path, bytes, { flag: 'wx' }),
    readFile: (path: string) => readFile(path),
    removeFile: (path: string) => rm(path),
    removeDirectory: (path: string) => rm(path, { recursive: true }),
    async listDirectory(path: string) {
      return (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        kind: nodeEntryKind(entry),
      }));
    },
    classifyError: (error: unknown) =>
      (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? ('already-exists' as const)
        : ('other' as const),
  };
}
function createMemoryPort() {
  const entries = new Map<string, { kind: 'file' | 'directory' | 'symlink'; bytes?: Uint8Array }>();
  const events: string[] = [];
  entries.set('/evidence', { kind: 'directory' });
  return {
    entries,
    events,
    port: {
      inspectPath: async (path: string) => {
        events.push(`inspect:${path}`);
        return entries.get(path) ?? null;
      },
      createDirectory: async (path: string) => {
        events.push(`mkdir:${path}`);
        if (entries.has(path)) throw new Error('exists');
        entries.set(path, { kind: 'directory' as const });
      },
      writeFileCreateNew: async (path: string, bytes: Uint8Array) => {
        events.push(`write:${path}`);
        if (entries.has(path)) throw new Error('exists');
        entries.set(path, { kind: 'file' as const, bytes });
      },
      readFile: async (path: string) => {
        events.push(`read:${path}`);
        const entry = entries.get(path);
        if (entry?.kind !== 'file' || !entry.bytes) throw new Error('missing');
        return entry.bytes;
      },
      removeFile: async (path: string) => {
        events.push(`remove-file:${path}`);
        if (!entries.delete(path)) throw new Error('missing');
      },
      removeDirectory: async (path: string) => {
        events.push(`remove-directory:${path}`);
        entries.delete(path);
      },
      listDirectory: async (path: string) => {
        events.push(`list:${path}`);
        return [...entries.keys()]
          .filter(
            (entry) => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes('/'),
          )
          .map((entry) => ({ name: entry.slice(path.length + 1), kind: entries.get(entry)!.kind }));
      },
      classifyError: (error: unknown) =>
        error instanceof Error && error.message === 'exists'
          ? ('already-exists' as const)
          : ('other' as const),
    },
  };
}

describe('RTC baseline evidence store', () => {
  it('creates accepted-artifact parents while holding the initialization lock', async () => {
    const memory = createMemoryPort();
    const store = createRtcBaselineFileStore({ rootPath: '/evidence', filePort: memory.port });
    expect(
      await store.initializeBaseline(
        baselineId,
        { 'environment.json': new TextEncoder().encode('{}') },
        [
          'results',
          'results/samples',
          'results/external-attempts',
          'results/external-cohorts',
          'results/failures',
          'results/finalization-failures',
          'artifacts',
          'artifacts/staging',
        ],
      ),
    ).toEqual({ ok: true, value: undefined });
    const events = memory.events.filter((event) => /^(write|mkdir|remove-file):/.test(event));
    expect(events).toEqual([
      'mkdir:/evidence/20260807-0123456789ab-e1-local',
      'write:/evidence/20260807-0123456789ab-e1-local/.writer.lock',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results/samples',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results/external-attempts',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results/external-cohorts',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results/failures',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results/finalization-failures',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/artifacts',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/artifacts/staging',
      'write:/evidence/20260807-0123456789ab-e1-local/environment.json',
      'remove-file:/evidence/20260807-0123456789ab-e1-local/.writer.lock',
    ]);
  });
  it('validates IDs and root, baseline, and lock symlinks before mutation', async () => {
    const memory = createMemoryPort();
    const store = createRtcBaselineFileStore({ rootPath: '/evidence', filePort: memory.port });
    expect(await store.writeJsonCreateNew('../outside', 'result.json', {})).toEqual(
      unconfinedFailure,
    );
    expect(
      await store.withFinalizationLock('../outside', async () => ({ ok: true, value: 1 })),
    ).toEqual(unconfinedFailure);
    expect(memory.events).toEqual([]);
    memory.entries.set('/evidence', { kind: 'symlink' });
    expect(await store.writeJsonCreateNew(baselineId, 'results/a.json', {})).toEqual(
      symlinkFailure,
    );
    expect(memory.events.some((event) => event.startsWith('write:'))).toBe(false);
    memory.entries.set('/evidence', { kind: 'directory' });
    memory.entries.set(`/evidence/${baselineId}`, { kind: 'symlink' });
    expect(
      await store.withFinalizationLock(baselineId, async () => ({ ok: true, value: 1 })),
    ).toEqual(symlinkFailure);
    memory.entries.set(`/evidence/${baselineId}`, { kind: 'directory' });
    memory.entries.set(`/evidence/${baselineId}/.writer.lock`, { kind: 'symlink' });
    expect(await store.writeJsonCreateNew(baselineId, 'results/a.json', {})).toEqual(
      symlinkFailure,
    );
  });
  it('keeps a complete finalization pair immutable and recovers a checksum-only orphan', async () => {
    const memory = createMemoryPort();
    memory.entries.set(baselinePath, { kind: 'directory' });
    const store = createRtcBaselineFileStore({ rootPath: '/evidence', filePort: memory.port });
    const bytes = new Uint8Array([0x80]);
    const checksum = new TextEncoder().encode(`${'a'.repeat(64)}  summary.json\n`);
    const publish = (summaryBytes = bytes) =>
      store.withFinalizationLock(baselineId, (writer) =>
        writer.publishSummary(baselineId, summaryBytes, checksum),
      );
    expect(await publish()).toEqual({ ok: true, value: undefined });
    expect(await publish()).toEqual({ ok: true, value: undefined });
    expect(await publish(new Uint8Array([0x81]))).toEqual({
      ok: false,
      issues: [
        {
          path: '$.summary',
          code: 'finalization-conflict',
          message: 'Finalized summary and checksum already exist with different bytes.',
        },
      ],
    });
    expect(memory.entries.get(`${baselinePath}/summary.json`)?.bytes).toEqual(bytes);
    memory.entries.delete(`${baselinePath}/summary.json`);
    expect(await publish()).toEqual({ ok: true, value: undefined });
    expect(memory.entries.get(`${baselinePath}/summary.json`)?.bytes).toEqual(bytes);
  });
  it('atomically reserves initialization so a concurrent loser never deletes the winner', async () => {
    const memory = createMemoryPort();
    memory.port.createDirectory = async (path, options) => {
      memory.events.push(`mkdir:${path}`);
      if (!options.recursive && memory.entries.has(path)) throw new Error('exists');
      memory.entries.set(path, { kind: 'directory' });
    };
    const store = createRtcBaselineFileStore({ rootPath: '/evidence', filePort: memory.port });
    const initialize = () =>
      store.initializeBaseline(baselineId, {
        'environment.json': new TextEncoder().encode('{}'),
      });
    const results = await Promise.all([initialize(), initialize()]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({
      ok: false,
      issues: [
        {
          path: '$.baseline',
          code: 'baseline-already-exists',
          message: 'Baseline directory already exists.',
        },
      ],
    });
    expect(memory.entries.get(baselinePath)?.kind).toBe('directory');
    expect(memory.entries.get(`${baselinePath}/environment.json`)?.kind).toBe('file');
  });
  it('rolls back the baseline directory when an initial file write fails', async () => {
    const memory = createMemoryPort();
    const originalWrite = memory.port.writeFileCreateNew;
    memory.port.writeFileCreateNew = async (path, bytes) => {
      if (path.endsWith('/manifest.json')) throw new Error('manifest write failed');
      await originalWrite(path, bytes);
    };
    const store = createRtcBaselineFileStore({ rootPath: '/evidence', filePort: memory.port });
    const result = await store.initializeBaseline(baselineId, {
      'environment.json': new TextEncoder().encode('{}'),
      'manifest.json': new TextEncoder().encode('{}'),
    });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: '$.manifest.json', code: 'write-failed', message: 'manifest write failed' }],
    });
    expect(memory.entries.has(baselinePath)).toBe(false);
    expect(memory.entries.has(`${baselinePath}/environment.json`)).toBe(false);
  });
  it('rolls back a created baseline after lock denial and reports cleanup failure', async () => {
    const memory = createMemoryPort();
    memory.port.writeFileCreateNew = async () => {
      throw new Error('permission denied');
    };
    memory.port.classifyError = () => 'permission-denied';
    memory.port.removeDirectory = async () => {
      throw new Error('rollback failed');
    };
    const store = createRtcBaselineFileStore({ rootPath: '/evidence', filePort: memory.port });
    expect(
      await store.initializeBaseline(baselineId, {
        'environment.json': new TextEncoder().encode('{}'),
      }),
    ).toEqual({
      ok: false,
      issues: [
        { path: '$.lock', code: 'lock-acquire-failed', message: 'permission denied' },
        { path: '$.baseline', code: 'rollback-failed', message: 'rollback failed' },
      ],
    });
  });
  it('propagates lock acquisition and release failures distinctly', async () => {
    const memory = createMemoryPort();
    memory.entries.set(baselinePath, { kind: 'directory' });
    memory.entries.set(`${baselinePath}/.writer.lock`, {
      kind: 'file',
      bytes: new Uint8Array(),
    });
    const store = createRtcBaselineFileStore({ rootPath: '/evidence', filePort: memory.port });
    expect(await store.writeJsonCreateNew(baselineId, 'results/a.json', {})).toEqual({
      ok: false,
      issues: [
        {
          path: '$.lock',
          code: 'lock-conflict',
          message: 'RTC baseline writer lock already exists.',
        },
      ],
    });
    memory.entries.delete(`${baselinePath}/.writer.lock`);
    memory.port.writeFileCreateNew = async () => {
      throw new Error('permission denied');
    };
    memory.port.classifyError = () => 'permission-denied';
    expect(await store.writeJsonCreateNew(baselineId, 'results/denied.json', {})).toEqual({
      ok: false,
      issues: [{ path: '$.lock', code: 'lock-acquire-failed', message: 'permission denied' }],
    });
    memory.port.classifyError = () => 'other';
    memory.port.writeFileCreateNew = async (path) => {
      if (path.endsWith('/.writer.lock')) {
        memory.entries.set(path, { kind: 'file', bytes: new Uint8Array() });
        return;
      }
      throw new Error('disk full');
    };
    memory.port.removeFile = async (path) => {
      if (path.endsWith('/.writer.lock')) throw new Error('release failed');
      memory.entries.delete(path);
    };
    expect(await store.writeJsonCreateNew(baselineId, 'results/b.json', {})).toEqual({
      ok: false,
      issues: [
        { path: '$.results/b.json', code: 'write-failed', message: 'disk full' },
        { path: '$.lock', code: 'lock-release-failed', message: 'release failed' },
      ],
    });
  });
  it('does not follow a baseline symlink swapped in before lock release', async () => {
    const memory = createMemoryPort();
    memory.entries.set(`/evidence/${baselineId}`, { kind: 'directory' });
    const store = createRtcBaselineFileStore({ rootPath: '/evidence', filePort: memory.port });
    expect(
      await store.withFinalizationLock(baselineId, async () => {
        memory.entries.set(`/evidence/${baselineId}`, { kind: 'symlink' });
        return { ok: true, value: undefined };
      }),
    ).toEqual(symlinkFailure);
    expect(memory.events).not.toContain(`remove-file:/evidence/${baselineId}/.writer.lock`);
  });
  it('confines a clean real root and never follows traversal or final symlinks', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'rtc-store-'));
    const rootPath = join(parent, 'evidence');
    const outsidePath = join(parent, 'sentinel');
    await writeFile(outsidePath, 'untouched');
    try {
      const store = createRtcBaselineFileStore({ rootPath, filePort: createNodePort() });
      expect(
        await store.initializeBaseline('../outside', { 'sentinel.json': new Uint8Array() }),
      ).toEqual(unconfinedFailure);
      expect(
        await store.initializeBaseline(
          baselineId,
          { 'environment.json': new TextEncoder().encode('{}') },
          ['results', 'artifacts/staging'],
        ),
      ).toEqual({ ok: true, value: undefined });
      await symlink(outsidePath, join(rootPath, baselineId, 'summary.json'));
      expect(
        await store.withFinalizationLock(baselineId, (writer) =>
          writer.publishSummary(baselineId, new Uint8Array(), new Uint8Array()),
        ),
      ).toEqual(symlinkFailure);
      await symlink(outsidePath, join(rootPath, baselineId, '.writer.lock'));
      expect(await store.writeJsonCreateNew(baselineId, 'results/a.json', {})).toEqual(
        symlinkFailure,
      );
      expect(await readFile(outsidePath, 'utf8')).toBe('untouched');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  it('enumerates only typed non-symlink artifacts and propagates directory failures', async () => {
    const memory = createMemoryPort();
    const resultsPath = `${baselinePath}/results`;
    memory.entries.set(baselinePath, { kind: 'directory' });
    memory.entries.set(resultsPath, { kind: 'directory' });
    memory.entries.set(`${resultsPath}/samples`, { kind: 'directory' });
    const emptyFile = { kind: 'file' as const, bytes: new Uint8Array() };
    memory.entries.set(`${resultsPath}/samples/z.json`, emptyFile);
    memory.entries.set(`${resultsPath}/samples/a.json`, emptyFile);
    const store = createRtcBaselineFileStore({ rootPath: '/evidence', filePort: memory.port });
    expect(await store.listArtifacts(baselineId, 'results')).toEqual({
      ok: true,
      value: [
        { relativePath: 'results/samples/a.json', kind: 'file' },
        { relativePath: 'results/samples/z.json', kind: 'file' },
      ],
    });
    memory.entries.set(`${resultsPath}/samples/link.json`, { kind: 'symlink' });
    expect(await store.listArtifacts(baselineId, 'results')).toEqual({
      ok: false,
      issues: [
        {
          path: '$.results/samples/link.json',
          code: 'symlink-entry',
          message: 'Artifact enumeration rejects symlink entries.',
        },
      ],
    });
    memory.port.listDirectory = async () => {
      throw new Error('list failed');
    };
    expect(await store.listArtifacts(baselineId, 'results')).toEqual({
      ok: false,
      issues: [{ path: '$.results', code: 'list-failed', message: 'list failed' }],
    });
  });
});
