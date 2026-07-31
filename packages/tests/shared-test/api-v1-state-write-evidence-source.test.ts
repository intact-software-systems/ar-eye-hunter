import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  readPostgresStateWriteEvidenceSource,
  requestPGliteStateWriteEvidenceSnapshot,
  resolveApiV1StateWriteEvidenceSource,
  runBoundedPGliteReaderCommand,
  selectApiV1StateWriteEvidenceSource,
} from '@shared-test/black-box-runner/api-v1-state-write-evidence-source.ts';

async function createSnapshotRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pglite-evidence-request-'));
  await Promise.all(
    ['requests', 'responses', 'snapshots'].map(
      async (directory) => await mkdir(path.join(root, directory), { mode: 0o700 }),
    ),
  );
  return root;
}

async function waitForSnapshotRequest(root: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [requestName] = (await readdir(path.join(root, 'requests'))).filter((name) =>
      name.endsWith('.json'),
    );
    if (requestName) return requestName;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Expected PGlite snapshot request.');
}

describe('API-v1 PGlite state-write evidence source', () => {
  it('selects an active PGlite owner-process snapshot publisher', () => {
    expect(
      resolveApiV1StateWriteEvidenceSource({
        RALLAR_SQL_BACKEND: 'pglite-memory',
        RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR: '/tmp/api-v1-black-box/snapshots',
      }),
    ).toEqual({ kind: 'pglite', snapshotDir: '/tmp/api-v1-black-box/snapshots' });
  });

  it('uses an explicit PostgreSQL URL without consulting a PGlite environment', () => {
    expect(
      selectApiV1StateWriteEvidenceSource('postgres://explicit.example/evidence', {
        RALLAR_SQL_BACKEND: 'pglite-memory',
        RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR: '/private/pglite-control',
      }),
    ).toEqual({ kind: 'postgres', databaseUrl: 'postgres://explicit.example/evidence' });
    expect(
      selectApiV1StateWriteEvidenceSource(undefined, {
        RALLAR_SQL_BACKEND: 'postgres',
        DATABASE_URL: 'postgres://default.example/evidence',
      }),
    ).toEqual({ kind: 'postgres', databaseUrl: 'postgres://default.example/evidence' });
  });

  it('closes an explicit PostgreSQL evidence client after its reader completes', async () => {
    const events: string[] = [];
    const sql = Object.assign(() => Promise.resolve([]), {
      end: async (input: { timeout: number }) => {
        events.push(`end:${input.timeout}`);
      },
    });
    const value = await readPostgresStateWriteEvidenceSource(
      { kind: 'postgres', databaseUrl: 'postgres://explicit.example/evidence' },
      async (opened) => {
        expect(opened).toBe(sql);
        events.push('read');
        return 'evidence';
      },
      (databaseUrl, options) => {
        expect(databaseUrl).toBe('postgres://explicit.example/evidence');
        expect(options).toEqual({ max: 1 });
        events.push('open');
        return sql as never;
      },
    );
    expect(value).toBe('evidence');
    expect(events).toEqual(['open', 'read', 'end:5']);
  });

  it('requires the exact nonce archive and removes every artifact on rejection', async () => {
    const root = await createSnapshotRoot();
    try {
      const pending = requestPGliteStateWriteEvidenceSnapshot(root);
      const requestName = await waitForSnapshotRequest(root);
      const request = JSON.parse(readFileSync(path.join(root, 'requests', requestName), 'utf8'));
      const unexpectedArchive = `${request.nonce}-wrong.tar`;
      await writeFile(path.join(root, 'snapshots', unexpectedArchive), 'snapshot', { mode: 0o600 });
      await writeFile(
        path.join(root, 'responses', `${request.nonce}.json`),
        JSON.stringify({
          ...request,
          publishedAtEpochMs: request.requestedAtEpochMs + 1,
          snapshotFile: unexpectedArchive,
        }),
        { mode: 0o600 },
      );

      await expect(pending).rejects.toThrow(/exact nonce archive/i);
      await expect(readdir(path.join(root, 'requests'))).resolves.toEqual([]);
      await expect(readdir(path.join(root, 'responses'))).resolves.toEqual([]);
      await expect(readdir(path.join(root, 'snapshots'))).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('creates the request with private permissions and removes request response and archive after success', async () => {
    const root = await createSnapshotRoot();
    try {
      const pending = requestPGliteStateWriteEvidenceSnapshot(root);
      const requestName = await waitForSnapshotRequest(root);
      const request = JSON.parse(readFileSync(path.join(root, 'requests', requestName), 'utf8'));
      expect((await stat(path.join(root, 'requests', requestName))).mode & 0o777).toBe(0o600);
      const snapshotName = `${request.nonce}.tar`;
      await writeFile(path.join(root, 'snapshots', snapshotName), 'snapshot', { mode: 0o600 });
      await writeFile(
        path.join(root, 'responses', `${request.nonce}.json`),
        JSON.stringify({
          ...request,
          publishedAtEpochMs: request.requestedAtEpochMs + 1,
          snapshotFile: snapshotName,
        }),
        { mode: 0o600 },
      );

      const snapshot = await pending;
      await snapshot.cleanup();
      await expect(readdir(path.join(root, 'requests'))).resolves.toEqual([]);
      await expect(readdir(path.join(root, 'responses'))).resolves.toEqual([]);
      await expect(readdir(path.join(root, 'snapshots'))).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('publishes its cancellation marker independently and leaves no marker temporary file', async () => {
    const root = await createSnapshotRoot();
    try {
      let clock = 0;
      await expect(
        requestPGliteStateWriteEvidenceSnapshot(root, {
          timeoutMs: 0,
          now: () => {
            clock += 1;
            return clock;
          },
        }),
      ).rejects.toThrow(/timed out/i);
      const cancellationNames = await readdir(path.join(root, 'cancellations'));
      expect(cancellationNames).toHaveLength(1);
      expect(cancellationNames[0]).toMatch(/^[a-f0-9]+\.json$/u);
      await expect(readdir(path.join(root, 'requests'))).resolves.toEqual([]);
      await expect(readdir(path.join(root, 'responses'))).resolves.toEqual([]);
      await expect(readdir(path.join(root, 'snapshots'))).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  for (const scenario of [
    {
      name: 'marker failure with successful cleanup',
      markerError: new Error('marker write failed'),
      cleanupError: undefined,
      expectedEvents: ['marker', 'cleanup'],
      expectedErrors: [
        'Timed out waiting 0ms for a PGlite evidence snapshot.',
        'marker write failed',
      ],
    },
    {
      name: 'cleanup failure with successful marker',
      markerError: undefined,
      cleanupError: new Error('artifact cleanup failed'),
      expectedEvents: ['marker', 'cleanup'],
      expectedErrors: [
        'Timed out waiting 0ms for a PGlite evidence snapshot.',
        'artifact cleanup failed',
      ],
    },
    {
      name: 'marker and cleanup failures',
      markerError: new Error('marker write failed'),
      cleanupError: new Error('artifact cleanup failed'),
      expectedEvents: ['marker', 'cleanup'],
      expectedErrors: [
        'Timed out waiting 0ms for a PGlite evidence snapshot.',
        'marker write failed',
        'artifact cleanup failed',
      ],
    },
  ] as const) {
    it(`surfaces ${scenario.name} after attempting both rejection operations`, async () => {
      const root = await createSnapshotRoot();
      const events: string[] = [];
      let clock = 0;
      try {
        await requestPGliteStateWriteEvidenceSnapshot(root, {
          timeoutMs: 0,
          now: () => {
            clock += 1;
            return clock;
          },
          rejectionOperations: {
            publishCancellation: async () => {
              events.push('marker');
              if (scenario.markerError) throw scenario.markerError;
            },
            cleanupArtifacts: async () => {
              events.push('cleanup');
              if (scenario.cleanupError) throw scenario.cleanupError;
            },
          },
        });
        throw new Error('Expected snapshot request rejection.');
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        const aggregate = error as AggregateError;
        expect(aggregate.errors.map((item) => (item as Error).message)).toEqual(
          scenario.expectedErrors,
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
      expect(events).toEqual(scenario.expectedEvents);
    });
  }

  it('kills a timed-out reader and rejects only after its close event', async () => {
    let closed = false;
    const pending = runBoundedPGliteReaderCommand(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1000)'],
      {
        timeoutMs: 20,
        maxOutputBytes: 1_000,
        afterClose: () => {
          closed = true;
        },
      },
    );
    await expect(pending).rejects.toThrow(/timed out/i);
    expect(closed).toBe(true);
  });

  it('kills a reader that exceeds the bounded output budget', async () => {
    await expect(
      runBoundedPGliteReaderCommand(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(4096)); setInterval(() => undefined, 1000)"],
        { timeoutMs: 1_000, maxOutputBytes: 64 },
      ),
    ).rejects.toThrow(/exceeded 64 output bytes/i);
  });

  it('observes reader close before rejecting a nonzero exit', async () => {
    const events: string[] = [];
    const pending = runBoundedPGliteReaderCommand(
      process.execPath,
      ['-e', "process.stderr.write('reader failed'); process.exit(2)"],
      {
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        afterClose: () => {
          events.push('close');
        },
      },
    );
    await expect(pending).rejects.toThrow(/exited 2/i);
    expect(events).toEqual(['close']);
  });
});
