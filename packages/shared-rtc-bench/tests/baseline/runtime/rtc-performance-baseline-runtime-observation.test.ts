import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DenoRtcBaselineAdapters } from '../../../baseline/runtime/rtc-baseline-deno-adapters.ts';
import { createRtcBaselineDenoRuntime } from '../../../baseline/runtime/rtc-baseline-deno-runtime.ts';

const baselineId = '20260816-956a057c9ab5-e1-local';

function readWorkerFlag(arguments_: readonly string[], name: string) {
  const value = arguments_.find((argument) => argument.startsWith(`--${name}=`));
  if (!value) {
    throw new Error(`Worker command is missing --${name}.`);
  }
  return value.slice(name.length + 3);
}

function createTemporaryFilePort(rootPath: string): DenoRtcBaselineAdapters['filePort'] {
  const toTemporaryPath = (path: string) => join(rootPath, path);
  let writerLockHeld = false;
  return {
    inspectPath: async (path) => {
      try {
        const entry = await stat(toTemporaryPath(path));
        return entry.isDirectory() ? { kind: 'directory' } : { kind: 'file' };
      } catch {
        return null;
      }
    },
    createDirectory: async (path, options) => {
      await mkdir(toTemporaryPath(path), options);
    },
    writeFileCreateNew: async (path, bytes) =>
      writeFile(toTemporaryPath(path), bytes, { flag: 'wx' }),
    readFile: async (path) => readFile(toTemporaryPath(path)),
    removeFile: async (path) => {
      await rm(toTemporaryPath(path));
    },
    removeDirectory: async (path) => rm(toTemporaryPath(path), { force: true, recursive: true }),
    listDirectory: async (path) =>
      (await readdir(toTemporaryPath(path), { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      })),
    async tryAcquireExclusiveFileLock(path) {
      if (writerLockHeld) return null;
      let created = true;
      let file;
      try {
        file = await open(toTemporaryPath(path), 'wx+');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        created = false;
        file = await open(toTemporaryPath(path), 'r+');
      }
      writerLockHeld = true;
      return {
        created,
        async readBytes() {
          const { size } = await file.stat();
          const bytes = new Uint8Array(size);
          await file.read(bytes, 0, size, 0);
          return bytes;
        },
        async writeBytes(bytes) {
          await file.truncate(0);
          await file.write(bytes, 0, bytes.length, 0);
          await file.sync();
        },
        async release() {
          writerLockHeld = false;
          await file.close();
        },
      };
    },
  };
}

function createNeutralSyntheticWorker(): DenoRtcBaselineAdapters['freshWorker'] {
  return {
    run: async ({ arguments: workerArguments }) => {
      const workloadId = readWorkerFlag(workerArguments, 'workload');
      const caseId = readWorkerFlag(workerArguments, 'case-id');
      const inputKey = readWorkerFlag(workerArguments, 'input-key');
      const intendedPhase = readWorkerFlag(workerArguments, 'intended-phase');
      const outerOrdinal = Number(readWorkerFlag(workerArguments, 'outer-ordinal'));
      const sampleIds = readWorkerFlag(workerArguments, 'sample-ids').split(',');
      return {
        ok: true as const,
        value: {
          exitStatus: 0,
          stdout: JSON.stringify(
            sampleIds.map((sampleId, index) => ({
              schema: 'rallar.rtc-baseline.sample.v1',
              identity: {
                sampleId,
                workloadId,
                caseId,
                inputKey,
                intendedPhase,
                outerOrdinal,
                innerOrdinal: index + 1,
              },
              outcome: 'passed',
              evidenceClass: 'synthetic-path',
              metrics: [{ metric: 'durationMs', unit: 'ms', value: index + 1 }],
              rawEvidence: null,
              rawReferences: [],
              issues: [],
              runtimeObservation: null,
            })),
          ),
          stderr: '',
        },
      };
    },
  };
}

async function createRuntimeAdapters(): Promise<{
  adapters: DenoRtcBaselineAdapters;
  rootPath: string;
}> {
  const rootPath = await mkdtemp(join(tmpdir(), 'rtc-runtime-observation-'));
  const adapters: DenoRtcBaselineAdapters = {
    filePort: createTemporaryFilePort(rootPath),
    writerLockRuntime: {
      createOwnerToken: () => '00000000-0000-4000-8000-000000000001',
      readOwnerIdentity: () => ({ hostname: 'runner-a', processId: 123 }),
      now: () => new Date('2026-08-16T10:00:00.000Z'),
      readProcessLiveness: async () => 'dead',
    },
    git: {
      readHeadCommit: async () => ({ ok: true, value: 'a'.repeat(40) }),
      readHeadTree: async () => ({ ok: true, value: 'b'.repeat(40) }),
      readRef: async () => ({ ok: true, value: 'codex/rtc-topology-service-ownership' }),
      readStatus: async () => ({ ok: true, value: '' }),
    },
    process: { run: async () => ({ ok: true, value: { exitStatus: 0, stdout: '', stderr: '' } }) },
    freshWorker: createNeutralSyntheticWorker(),
    environment: { readAllowlisted: () => ({}) },
    runtimeHost: {
      read: async () => ({
        os: 'darwin',
        kernel: '24.6.0',
        architecture: 'arm64',
        logicalCpuCount: 10,
        cpuModel: 'Apple M4',
        totalMemoryBytes: 1,
        deno: '2.4.0',
        executionContext: 'local' as const,
      }),
    },
    clock: { nowUtc: () => '2026-08-16T10:00:00.000Z', monotonicNowMs: () => 10 },
    sourceConfigHashing: { read: async () => ({ ok: true, value: [] }) },
    sha256: async () => 'c'.repeat(64),
  };
  return { adapters, rootPath };
}

describe('RTC baseline Deno runtime observation binding', () => {
  it('carries the initialized runtime observation into B03 synthetic metric finalization', async () => {
    const { adapters, rootPath } = await createRuntimeAdapters();
    const runtime = createRtcBaselineDenoRuntime(adapters);
    try {
      expect(
        await runtime.initializeBaseline({
          schema: 'rallar.rtc-baseline.capture-request.v1',
          baselineId,
          workloadIds: ['RTC-B03'],
          environmentId: 'E1-local',
          retainedSampleMultiplier: 1,
          repeatLink: null,
          conditionalEnvironmentDecisions: [],
        }),
      ).toMatchObject({ ok: true });
      const manifestPath = join(rootPath, 'tmp/perf/rtc-baseline', baselineId, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const outerAttempt = manifest.outerAttempts.find(
        (entry: { caseId: string; inputKey: string }) =>
          entry.caseId === 'topology-star' && entry.inputKey === 'sessions-30',
      );
      manifest.cases = manifest.cases.filter(
        (entry: { caseId: string; inputKey: string }) =>
          entry.caseId === outerAttempt.caseId && entry.inputKey === outerAttempt.inputKey,
      );
      manifest.outerAttempts = [outerAttempt];
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      expect(await runtime.captureWorkload({ baselineId, workloadId: 'RTC-B03' })).toMatchObject({
        ok: true,
      });
      const samplePath = join(
        rootPath,
        'tmp/perf/rtc-baseline',
        baselineId,
        'results/samples',
        `${outerAttempt.sampleIds[0]}.json`,
      );
      const environmentPath = join(
        rootPath,
        'tmp/perf/rtc-baseline',
        baselineId,
        'environment.json',
      );
      const sample = JSON.parse(await readFile(samplePath, 'utf8'));
      const environment = JSON.parse(await readFile(environmentPath, 'utf8'));
      expect(sample.runtimeObservation).toEqual(environment.observation);
      expect(sample.identity).toEqual({
        sampleId: outerAttempt.sampleIds[0],
        workloadId: outerAttempt.workloadId,
        caseId: outerAttempt.caseId,
        inputKey: outerAttempt.inputKey,
        intendedPhase: outerAttempt.intendedPhase,
        outerOrdinal: outerAttempt.outerOrdinal,
        innerOrdinal: 1,
      });
      expect(sample).toMatchObject({
        outcome: 'passed',
        evidenceClass: 'synthetic-path',
        metrics: [{ metric: 'durationMs', unit: 'ms', value: 1 }],
        rawEvidence: null,
        rawReferences: [],
        issues: [],
      });
      const finalized = await runtime.finalize({ baselineId });
      expect(finalized).toMatchObject({ ok: true });
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });
});
