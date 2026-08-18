import { describe, expect, it } from 'vitest';
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRtcBaselineFileStore } from '../../../baseline/evidence/rtc-baseline-evidence-store.ts';
import type { RtcBaselineFilePort } from '../../../baseline/evidence/rtc-baseline-file-port.ts';
import { createRtcBaselineOwnedWriterLockMetadata } from '../../../baseline/evidence/rtc-baseline-writer-lock-metadata.ts';

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
const ownerToken = '00000000-0000-4000-8000-000000000001';
const previousOwnerToken = '00000000-0000-4000-8000-000000000000';

interface WriterLockRuntimeTestInput {
  readonly ownerToken: string;
  readonly hostname: string;
  readonly processId: number;
  readonly nowUtc: string;
  readonly processLiveness: 'alive' | 'dead' | 'unknown';
}
function nodeEntryKind(value: { isSymbolicLink(): boolean; isDirectory(): boolean }) {
  if (value.isSymbolicLink()) return 'symlink' as const;
  return value.isDirectory() ? ('directory' as const) : ('file' as const);
}
function createNodePort() {
  let lockHeld = false;
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
    async tryAcquireExclusiveFileLock(path: string) {
      if (lockHeld) return null;
      let created = true;
      let file;
      try {
        file = await open(path, 'wx+');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        created = false;
        file = await open(path, 'r+');
      }
      lockHeld = true;
      return {
        created,
        async readBytes() {
          const { size } = await file.stat();
          const bytes = new Uint8Array(size);
          await file.read(bytes, 0, size, 0);
          return bytes;
        },
        async writeBytes(bytes: Uint8Array) {
          await file.truncate(0);
          await file.write(bytes, 0, bytes.length, 0);
          await file.sync();
        },
        async release() {
          lockHeld = false;
          await file.close();
        },
      };
    },
  };
}
function createMemoryPort() {
  const entries = new Map<string, { kind: 'file' | 'directory' | 'symlink'; bytes?: Uint8Array }>();
  const events: string[] = [];
  let heldWriterLockId: number | null = null;
  let nextWriterLockId = 1;
  entries.set('/evidence', { kind: 'directory' });
  const port: RtcBaselineFilePort = {
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
      for (const entry of entries.keys()) {
        if (entry === path || entry.startsWith(`${path}/`)) entries.delete(entry);
      }
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
    async tryAcquireExclusiveFileLock(path: string) {
      events.push(`lock:${path}`);
      if (heldWriterLockId !== null) {
        return null;
      }
      const existing = entries.get(path);
      if (existing !== undefined && existing.kind !== 'file') {
        throw new Error('lock path is not a file');
      }
      const created = existing === undefined;
      if (created) {
        entries.set(path, { kind: 'file', bytes: new Uint8Array() });
      }
      const writerLockId = nextWriterLockId;
      nextWriterLockId += 1;
      heldWriterLockId = writerLockId;
      return {
        created,
        async readBytes() {
          const entry = entries.get(path);
          if (entry?.kind !== 'file') {
            throw new Error('lock file disappeared');
          }
          return entry.bytes ?? new Uint8Array();
        },
        async writeBytes(bytes: Uint8Array) {
          const entry = entries.get(path);
          if (entry?.kind !== 'file') {
            throw new Error('lock file disappeared');
          }
          entries.set(path, { kind: 'file', bytes });
        },
        async release() {
          if (heldWriterLockId === writerLockId) {
            heldWriterLockId = null;
          }
        },
      };
    },
  };
  return {
    entries,
    events,
    port,
    abandonWriterLock() {
      heldWriterLockId = null;
    },
  };
}

function createWriterLockRuntime(
  input: WriterLockRuntimeTestInput = {
    ownerToken,
    hostname: 'runner-a',
    processId: 123,
    nowUtc: '2026-08-07T10:00:00.000Z',
    processLiveness: 'dead',
  },
) {
  let now = new Date(input.nowUtc);
  let processLiveness = input.processLiveness;
  return {
    runtime: {
      createOwnerToken: () => input.ownerToken,
      readOwnerIdentity: () => ({ hostname: input.hostname, processId: input.processId }),
      now: () => now,
      readProcessLiveness: async () => processLiveness,
    },
    setNow(value: string) {
      now = new Date(value);
    },
    setProcessLiveness(value: 'alive' | 'dead' | 'unknown') {
      processLiveness = value;
    },
  };
}

function createMemoryStore(
  memory: ReturnType<typeof createMemoryPort>,
  writerLockRuntime = createWriterLockRuntime().runtime,
) {
  const storeInput = {
    rootPath: '/evidence',
    filePort: memory.port,
    writerLockRuntime,
    writerLockConfig: { staleAfterMs: 300_000 },
  };
  return createRtcBaselineFileStore(storeInput);
}

function readMemoryJson(memory: ReturnType<typeof createMemoryPort>, path: string) {
  const bytes = memory.entries.get(path)?.bytes;
  return bytes === undefined || bytes.length === 0
    ? undefined
    : JSON.parse(new TextDecoder().decode(bytes));
}

function setOwnedWriterLock(
  memory: ReturnType<typeof createMemoryPort>,
  input: {
    readonly ownerToken: string;
    readonly hostname: string;
    readonly processId: number;
    readonly createdAtUtc: string;
  },
) {
  memory.entries.set(`${baselinePath}/.writer.lock`, {
    kind: 'file',
    bytes: new TextEncoder().encode(
      `${JSON.stringify({
        schema: 'rallar.rtc-baseline.writer-lock.v1',
        state: 'owned',
        ...input,
      })}\n`,
    ),
  });
}

function setWriterLockBytes(memory: ReturnType<typeof createMemoryPort>, value: string) {
  memory.entries.set(`${baselinePath}/.writer.lock`, {
    kind: 'file',
    bytes: new TextEncoder().encode(value),
  });
}

describe('RTC baseline evidence store', () => {
  it('projects owned writer-lock metadata onto the persisted schema', () => {
    const widerInput = {
      ownerToken,
      hostname: 'runner-a',
      processId: 123,
      createdAtUtc: '2026-08-07T10:00:00.000Z',
      schema: 'unsupported',
      state: 'released',
      unexpected: true,
    };

    expect(createRtcBaselineOwnedWriterLockMetadata(widerInput)).toEqual({
      schema: 'rallar.rtc-baseline.writer-lock.v1',
      state: 'owned',
      ownerToken,
      hostname: 'runner-a',
      processId: 123,
      createdAtUtc: '2026-08-07T10:00:00.000Z',
    });
  });

  it('persists token-scoped metadata through normal acquire and release', async () => {
    const memory = createMemoryPort();
    const writerLockRuntime = createWriterLockRuntime();
    memory.entries.set(baselinePath, { kind: 'directory' });
    const store = createMemoryStore(memory, writerLockRuntime.runtime);
    let acquiredMetadata: unknown;

    const result = await store.withFinalizationLock(baselineId, async () => {
      acquiredMetadata = readMemoryJson(memory, `${baselinePath}/.writer.lock`);
      writerLockRuntime.setNow('2026-08-07T10:00:01.000Z');
      return { ok: true, value: 'complete' };
    });

    expect(result).toEqual({ ok: true, value: 'complete' });
    expect(acquiredMetadata).toEqual({
      schema: 'rallar.rtc-baseline.writer-lock.v1',
      state: 'owned',
      ownerToken,
      hostname: 'runner-a',
      processId: 123,
      createdAtUtc: '2026-08-07T10:00:00.000Z',
    });
    expect(readMemoryJson(memory, `${baselinePath}/.writer.lock`)).toEqual({
      schema: 'rallar.rtc-baseline.writer-lock.v1',
      state: 'released',
      ownerToken,
      hostname: 'runner-a',
      processId: 123,
      createdAtUtc: '2026-08-07T10:00:00.000Z',
      releasedAtUtc: '2026-08-07T10:00:01.000Z',
    });
    expect(memory.events).not.toContain(`remove-file:${baselinePath}/.writer.lock`);
  });

  it('recovers a sufficiently old same-host lock after its process is proven dead', async () => {
    const memory = createMemoryPort();
    memory.entries.set(baselinePath, { kind: 'directory' });
    setOwnedWriterLock(memory, {
      ownerToken: previousOwnerToken,
      hostname: 'runner-a',
      processId: 122,
      createdAtUtc: '2026-08-07T09:54:59.999Z',
    });
    const store = createMemoryStore(memory);
    let recoveredMetadata: unknown;

    const result = await store.withFinalizationLock(baselineId, async () => {
      recoveredMetadata = readMemoryJson(memory, `${baselinePath}/.writer.lock`);
      return { ok: true, value: 'recovered' };
    });

    expect(result).toEqual({ ok: true, value: 'recovered' });
    expect(recoveredMetadata).toEqual({
      schema: 'rallar.rtc-baseline.writer-lock.v1',
      state: 'owned',
      ownerToken,
      hostname: 'runner-a',
      processId: 123,
      createdAtUtc: '2026-08-07T10:00:00.000Z',
    });
  });

  it('allows exactly one concurrent stale-lock recovery winner', async () => {
    const memory = createMemoryPort();
    memory.entries.set(baselinePath, { kind: 'directory' });
    setOwnedWriterLock(memory, {
      ownerToken: previousOwnerToken,
      hostname: 'runner-a',
      processId: 122,
      createdAtUtc: '2026-08-07T09:54:59.999Z',
    });
    const first = createMemoryStore(memory);
    const second = createMemoryStore(
      memory,
      createWriterLockRuntime({
        ownerToken: '00000000-0000-4000-8000-000000000002',
        hostname: 'runner-a',
        processId: 124,
        nowUtc: '2026-08-07T10:00:00.000Z',
        processLiveness: 'dead',
      }).runtime,
    );
    let releaseWinner!: () => void;
    const winnerMayFinish = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let winnerStarted!: () => void;
    const winnerHasStarted = new Promise<void>((resolve) => {
      winnerStarted = resolve;
    });
    let operationCount = 0;
    const firstResult = first.withFinalizationLock(baselineId, async () => {
      operationCount += 1;
      winnerStarted();
      await winnerMayFinish;
      return { ok: true, value: 'first' };
    });
    await winnerHasStarted;

    const secondResult = await second.withFinalizationLock(baselineId, async () => {
      operationCount += 1;
      return { ok: true, value: 'second' };
    });
    releaseWinner();

    expect(await firstResult).toEqual({ ok: true, value: 'first' });
    expect(secondResult).toEqual({
      ok: false,
      issues: [
        {
          path: '$.lock',
          code: 'lock-conflict',
          message: 'Another RTC baseline writer currently holds the lock.',
        },
      ],
    });
    expect(operationCount).toBe(1);
  });

  it('prevents a delayed old owner from releasing a replacement owner lock', async () => {
    const memory = createMemoryPort();
    memory.entries.set(baselinePath, { kind: 'directory' });
    const oldRuntime = createWriterLockRuntime({
      ownerToken: previousOwnerToken,
      hostname: 'runner-a',
      processId: 122,
      nowUtc: '2026-08-07T09:50:00.000Z',
      processLiveness: 'dead',
    });
    const oldStore = createMemoryStore(memory, oldRuntime.runtime);
    let finishOldOwner!: () => void;
    const oldOwnerMayFinish = new Promise<void>((resolve) => {
      finishOldOwner = resolve;
    });
    let oldOwnerStarted!: () => void;
    const oldOwnerHasStarted = new Promise<void>((resolve) => {
      oldOwnerStarted = resolve;
    });
    const oldResult = oldStore.withFinalizationLock(baselineId, async () => {
      oldOwnerStarted();
      await oldOwnerMayFinish;
      return { ok: true, value: 'old' };
    });
    await oldOwnerHasStarted;
    memory.abandonWriterLock();

    const newStore = createMemoryStore(memory);
    let finishNewOwner!: () => void;
    const newOwnerMayFinish = new Promise<void>((resolve) => {
      finishNewOwner = resolve;
    });
    let newOwnerStarted!: () => void;
    const newOwnerHasStarted = new Promise<void>((resolve) => {
      newOwnerStarted = resolve;
    });
    const newResult = newStore.withFinalizationLock(baselineId, async () => {
      newOwnerStarted();
      await newOwnerMayFinish;
      return { ok: true, value: 'new' };
    });
    await newOwnerHasStarted;
    finishOldOwner();

    expect(await oldResult).toEqual({
      ok: false,
      issues: [
        {
          path: '$.lock',
          code: 'lock-ownership-lost',
          message: 'Writer lock ownership changed before release; the replacement was preserved.',
        },
      ],
    });
    expect(readMemoryJson(memory, `${baselinePath}/.writer.lock`)).toMatchObject({
      state: 'owned',
      ownerToken,
    });
    finishNewOwner();
    expect(await newResult).toEqual({ ok: true, value: 'new' });
  });

  it.each([
    {
      name: 'malformed metadata',
      arrange(memory: ReturnType<typeof createMemoryPort>) {
        setWriterLockBytes(memory, '{not-json');
      },
      processLiveness: 'dead' as const,
      code: 'lock-metadata-invalid',
      message: 'Writer lock metadata is malformed or uses an unsupported schema.',
    },
    {
      name: 'null metadata',
      arrange(memory: ReturnType<typeof createMemoryPort>) {
        setWriterLockBytes(memory, 'null');
      },
      processLiveness: 'dead' as const,
      code: 'lock-metadata-invalid',
      message: 'Writer lock metadata is malformed or uses an unsupported schema.',
    },
    {
      name: 'array metadata',
      arrange(memory: ReturnType<typeof createMemoryPort>) {
        setWriterLockBytes(memory, '[]');
      },
      processLiveness: 'dead' as const,
      code: 'lock-metadata-invalid',
      message: 'Writer lock metadata is malformed or uses an unsupported schema.',
    },
    {
      name: 'owned metadata with an unexpected field',
      arrange(memory: ReturnType<typeof createMemoryPort>) {
        setWriterLockBytes(
          memory,
          JSON.stringify({
            schema: 'rallar.rtc-baseline.writer-lock.v1',
            state: 'owned',
            ownerToken: previousOwnerToken,
            hostname: 'runner-a',
            processId: 122,
            createdAtUtc: '2026-08-07T09:00:00.000Z',
            unexpected: true,
          }),
        );
      },
      processLiveness: 'dead' as const,
      code: 'lock-metadata-invalid',
      message: 'Writer lock metadata is malformed or uses an unsupported schema.',
    },
    {
      name: 'a remote host owner',
      arrange(memory: ReturnType<typeof createMemoryPort>) {
        setOwnedWriterLock(memory, {
          ownerToken: previousOwnerToken,
          hostname: 'runner-b',
          processId: 122,
          createdAtUtc: '2026-08-07T09:00:00.000Z',
        });
      },
      processLiveness: 'dead' as const,
      code: 'lock-owner-remote',
      message: 'Writer lock belongs to host runner-b; remote process liveness cannot be proven.',
    },
    {
      name: 'a future creation time',
      arrange(memory: ReturnType<typeof createMemoryPort>) {
        setOwnedWriterLock(memory, {
          ownerToken: previousOwnerToken,
          hostname: 'runner-a',
          processId: 122,
          createdAtUtc: '2026-08-07T10:00:00.001Z',
        });
      },
      processLiveness: 'dead' as const,
      code: 'lock-clock-anomaly',
      message: 'Writer lock creation time is later than the local clock; recovery was refused.',
    },
    {
      name: 'unknown process liveness',
      arrange(memory: ReturnType<typeof createMemoryPort>) {
        setOwnedWriterLock(memory, {
          ownerToken: previousOwnerToken,
          hostname: 'runner-a',
          processId: 122,
          createdAtUtc: '2026-08-07T09:00:00.000Z',
        });
      },
      processLiveness: 'unknown' as const,
      code: 'lock-liveness-unknown',
      message: 'Writer process 122 liveness could not be proven; recovery was refused.',
    },
    {
      name: 'a live process',
      arrange(memory: ReturnType<typeof createMemoryPort>) {
        setOwnedWriterLock(memory, {
          ownerToken: previousOwnerToken,
          hostname: 'runner-a',
          processId: 122,
          createdAtUtc: '2026-08-07T09:00:00.000Z',
        });
      },
      processLiveness: 'alive' as const,
      code: 'lock-owner-live',
      message: 'Writer process 122 is still alive; recovery was refused.',
    },
    {
      name: 'a dead owner below the stale threshold',
      arrange(memory: ReturnType<typeof createMemoryPort>) {
        setOwnedWriterLock(memory, {
          ownerToken: previousOwnerToken,
          hostname: 'runner-a',
          processId: 122,
          createdAtUtc: '2026-08-07T09:55:00.001Z',
        });
      },
      processLiveness: 'dead' as const,
      code: 'lock-owner-not-stale',
      message:
        'Writer process 122 is dead, but its lock has not reached the 300000ms stale threshold.',
    },
  ])('fails closed for $name', async ({ arrange, processLiveness, code, message }) => {
    const memory = createMemoryPort();
    memory.entries.set(baselinePath, { kind: 'directory' });
    arrange(memory);
    const runtime = createWriterLockRuntime({
      ownerToken,
      hostname: 'runner-a',
      processId: 123,
      nowUtc: '2026-08-07T10:00:00.000Z',
      processLiveness,
    });
    const store = createMemoryStore(memory, runtime.runtime);
    let operationInvoked = false;

    expect(
      await store.withFinalizationLock(baselineId, async () => {
        operationInvoked = true;
        return { ok: true, value: 1 };
      }),
    ).toEqual({
      ok: false,
      issues: [{ path: '$.lock', code, message }],
    });
    expect(operationInvoked).toBe(false);
  });

  it('creates accepted-artifact parents while holding the initialization lock', async () => {
    const memory = createMemoryPort();
    const store = createMemoryStore(memory);
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
    const events = memory.events.filter((event) => /^(lock|write|mkdir|remove-file):/.test(event));
    expect(events).toEqual([
      'mkdir:/evidence/20260807-0123456789ab-e1-local',
      'lock:/evidence/20260807-0123456789ab-e1-local/.writer.lock',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results/samples',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results/external-attempts',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results/external-cohorts',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results/failures',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/results/finalization-failures',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/artifacts',
      'mkdir:/evidence/20260807-0123456789ab-e1-local/artifacts/staging',
      'write:/evidence/20260807-0123456789ab-e1-local/environment.json',
    ]);
  });
  it('validates IDs and root, baseline, and lock symlinks before mutation', async () => {
    const memory = createMemoryPort();
    const store = createMemoryStore(memory);
    expect(await store.writeJsonCreateNew('../outside', 'result.json', {})).toEqual(
      unconfinedFailure,
    );
    expect(
      await store.withFinalizationLock('../outside', async () => ({ ok: true, value: 1 })),
    ).toEqual(unconfinedFailure);
    expect(memory.events).toEqual([]);
    memory.entries.set(baselinePath, { kind: 'directory' });
    expect(await store.writeJsonCreateNew(baselineId, '../outside', {})).toEqual(unconfinedFailure);
    expect(memory.events).toEqual([]);
    memory.entries.delete(baselinePath);
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
    const store = createMemoryStore(memory);
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
    const store = createMemoryStore(memory);
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
  it('keeps failed initialization cleanup inside its lock and preserves a replacement writer', async () => {
    const memory = createMemoryPort();
    const acquireLock = memory.port.tryAcquireExclusiveFileLock;
    let wrapFirstRelease = true;
    let replacementResult: unknown;
    const replacementStore = createMemoryStore(
      memory,
      createWriterLockRuntime({
        ownerToken: '00000000-0000-4000-8000-000000000002',
        hostname: 'runner-a',
        processId: 124,
        nowUtc: '2026-08-07T10:00:01.000Z',
        processLiveness: 'dead',
      }).runtime,
    );
    memory.port.tryAcquireExclusiveFileLock = async (path) => {
      const lock = await acquireLock(path);
      if (lock === null || !wrapFirstRelease) return lock;
      wrapFirstRelease = false;
      return {
        ...lock,
        async release() {
          await lock.release();
          replacementResult = await replacementStore.withFinalizationLock(baselineId, (writer) =>
            writer.writeJsonCreateNew(baselineId, 'environment.json', {}),
          );
        },
      };
    };
    const originalWrite = memory.port.writeFileCreateNew;
    memory.port.writeFileCreateNew = async (path, bytes) => {
      if (path.endsWith('/manifest.json')) throw new Error('manifest write failed');
      await originalWrite(path, bytes);
    };
    const store = createMemoryStore(memory);
    const result = await store.initializeBaseline(baselineId, {
      'environment.json': new TextEncoder().encode('{}'),
      'manifest.json': new TextEncoder().encode('{}'),
    });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: '$.manifest.json', code: 'write-failed', message: 'manifest write failed' }],
    });
    expect(replacementResult!).toEqual({ ok: true, value: undefined });
    expect(memory.entries.has(baselinePath)).toBe(true);
    expect(memory.entries.has(`${baselinePath}/environment.json`)).toBe(true);
    expect(memory.events).not.toContain(`remove-directory:${baselinePath}`);
  });
  it('does not mutate a reserved baseline after failing to acquire its writer lock', async () => {
    const memory = createMemoryPort();
    memory.port.tryAcquireExclusiveFileLock = async () => null;
    const store = createMemoryStore(memory);
    expect(
      await store.initializeBaseline(baselineId, {
        'environment.json': new TextEncoder().encode('{}'),
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: '$.lock',
          code: 'lock-conflict',
          message: 'Another RTC baseline writer currently holds the lock.',
        },
      ],
    });
    expect(memory.entries.has(baselinePath)).toBe(true);
    expect(memory.events).not.toContain(`remove-directory:${baselinePath}`);
  });
  it('propagates lock acquisition and release failures distinctly', async () => {
    const memory = createMemoryPort();
    memory.entries.set(baselinePath, { kind: 'directory' });
    const store = createMemoryStore(memory);
    const acquireLock = memory.port.tryAcquireExclusiveFileLock;
    memory.port.tryAcquireExclusiveFileLock = async () => null;
    expect(await store.writeJsonCreateNew(baselineId, 'results/a.json', {})).toEqual({
      ok: false,
      issues: [
        {
          path: '$.lock',
          code: 'lock-conflict',
          message: 'Another RTC baseline writer currently holds the lock.',
        },
      ],
    });
    memory.port.tryAcquireExclusiveFileLock = async () => {
      throw new Error('permission denied');
    };
    expect(await store.writeJsonCreateNew(baselineId, 'results/denied.json', {})).toEqual({
      ok: false,
      issues: [{ path: '$.lock', code: 'lock-acquire-failed', message: 'permission denied' }],
    });
    memory.port.tryAcquireExclusiveFileLock = async (path) => {
      const lock = await acquireLock(path);
      if (lock === null) return null;
      return {
        ...lock,
        release: async () => {
          await lock.release();
          throw new Error('release failed');
        },
      };
    };
    memory.port.writeFileCreateNew = async (path) => {
      throw new Error('disk full');
    };
    expect(await store.writeJsonCreateNew(baselineId, 'results/b.json', {})).toEqual({
      ok: false,
      issues: [
        { path: '$.results/b.json', code: 'write-failed', message: 'disk full' },
        { path: '$.lock', code: 'lock-release-failed', message: 'release failed' },
      ],
    });
  });
  it('releases the opened lock handle without following a swapped baseline symlink', async () => {
    const memory = createMemoryPort();
    memory.entries.set(`/evidence/${baselineId}`, { kind: 'directory' });
    const store = createMemoryStore(memory);
    expect(
      await store.withFinalizationLock(baselineId, async () => {
        memory.entries.set(`/evidence/${baselineId}`, { kind: 'symlink' });
        return { ok: true, value: undefined };
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(memory.events).not.toContain(`remove-file:/evidence/${baselineId}/.writer.lock`);
  });
  it('confines a clean real root and never follows traversal or final symlinks', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'rtc-store-'));
    const rootPath = join(parent, 'evidence');
    const outsidePath = join(parent, 'sentinel');
    await writeFile(outsidePath, 'untouched');
    try {
      const store = createRtcBaselineFileStore({
        rootPath,
        filePort: createNodePort(),
        writerLockRuntime: createWriterLockRuntime().runtime,
        writerLockConfig: { staleAfterMs: 300_000 },
      });
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
      await rm(join(rootPath, baselineId, '.writer.lock'));
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
    const store = createMemoryStore(memory);
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
