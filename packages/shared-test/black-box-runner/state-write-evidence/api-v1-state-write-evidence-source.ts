import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import type {
  ApiV1StateWriteEvidence,
  ApiV1StateWriteEvidenceQuery,
  ApiV1StateWriteEvidenceSql,
  ApiV1StateWriteEvidenceSqlParameter,
  ApiV1StateWriteEvidenceSpec,
} from './api-v1-state-write-evidence-contracts.ts';

const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/appdb';
const SNAPSHOT_DIR_ENV = 'RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR';
const SNAPSHOT_TIMEOUT_MS = 10_000;
const SNAPSHOT_READER_TIMEOUT_MS = 15_000;
const SNAPSHOT_READER_MAX_OUTPUT_BYTES = 1_000_000;

export type ApiV1StateWriteEvidenceSource =
  | Readonly<{
      kind: 'postgres';
      databaseUrl: string;
    }>
  | Readonly<{
      kind: 'pglite';
      snapshotDir: string;
    }>;

type SnapshotResponse = Readonly<{
  nonce: string;
  generation: string;
  requestedAtEpochMs: number;
  publishedAtEpochMs: number;
  snapshotFile?: string;
  failure?: string;
}>;

type PostgresSqlFactory = (databaseUrl: string, options: Readonly<{ max: number }>) => Sql;

type SnapshotRejectionOperations = Readonly<{
  cleanupArtifacts(snapshotDir: string, nonce: string): Promise<void>;
  publishCancellation(snapshotDir: string, nonce: string): Promise<void>;
}>;

export function resolveApiV1StateWriteEvidenceSource(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApiV1StateWriteEvidenceSource {
  const backend = env.RALLAR_SQL_BACKEND?.trim() ?? 'postgres';
  if (backend === 'pglite-memory' || backend === 'pglite-file') {
    const snapshotDir = env[SNAPSHOT_DIR_ENV]?.trim();
    if (!snapshotDir) {
      throw new Error('State-write evidence requires a private active PGlite snapshot publisher.');
    }
    return { kind: 'pglite', snapshotDir };
  }
  if (backend !== 'postgres') {
    throw new Error(`State-write evidence does not support SQL backend: ${backend}`);
  }
  return {
    kind: 'postgres',
    databaseUrl: env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
  };
}

export function selectApiV1StateWriteEvidenceSource(
  databaseUrl: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApiV1StateWriteEvidenceSource {
  if (databaseUrl !== undefined) {
    return { kind: 'postgres', databaseUrl };
  }
  return resolveApiV1StateWriteEvidenceSource(env);
}

export async function readPostgresStateWriteEvidenceSource<T>(
  source: Extract<ApiV1StateWriteEvidenceSource, { kind: 'postgres' }>,
  read: (sql: Sql) => Promise<T>,
  createSql: PostgresSqlFactory = postgres,
): Promise<T> {
  const sql = createSql(source.databaseUrl, { max: 1 });
  try {
    return await read(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function readPGliteStateWriteEvidenceSnapshot(
  source: Extract<ApiV1StateWriteEvidenceSource, { kind: 'pglite' }>,
  input: unknown,
): Promise<ApiV1StateWriteEvidence> {
  const snapshot = await requestPGliteStateWriteEvidenceSnapshot(source.snapshotDir);
  try {
    return await runPGliteSnapshotReader(snapshot.path, input);
  } finally {
    await snapshot.cleanup();
  }
}

export async function collectApiV1StateWriteEvidence(
  input: unknown,
  databaseUrl?: string,
): Promise<ApiV1StateWriteEvidence> {
  const source = selectApiV1StateWriteEvidenceSource(databaseUrl);
  if (source.kind === 'postgres') {
    const { collectApiV1StateWriteEvidenceFromSql } =
      await import('./api-v1-state-write-evidence-sql.ts');
    return await readPostgresStateWriteEvidenceSource(
      source,
      async (sql) =>
        await collectApiV1StateWriteEvidenceFromSql(input, toStateWriteEvidenceSql(sql)),
    );
  }
  return await readPGliteStateWriteEvidenceSnapshot(source, input);
}

export function toStateWriteEvidenceSql(sql: Sql): ApiV1StateWriteEvidenceSql {
  const query = toStateWriteEvidenceQuery(sql);
  return Object.assign(query, {
    begin: async (write: (transaction: ApiV1StateWriteEvidenceQuery) => Promise<void>) => {
      await sql.begin(async (transaction) => await write(toStateWriteEvidenceQuery(transaction)));
    },
  });
}

function toStateWriteEvidenceQuery(sql: Sql | TransactionSql): ApiV1StateWriteEvidenceQuery {
  const query: ApiV1StateWriteEvidenceQuery = <Rows extends readonly (object | undefined)[]>(
    strings: TemplateStringsArray,
    ...values: readonly ApiV1StateWriteEvidenceSqlParameter[]
  ): Promise<Rows> => sql<Rows>(strings, ...values).then((rows) => rows);
  return query;
}

export async function requestPGliteStateWriteEvidenceSnapshot(
  snapshotDir: string,
  options: Readonly<{
    timeoutMs?: number;
    now?: () => number;
    rejectionOperations?: SnapshotRejectionOperations;
  }> = {},
): Promise<Readonly<{ path: string; cleanup(): Promise<void> }>> {
  const now = options.now ?? Date.now;
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const generation = crypto.randomUUID().replaceAll('-', '');
  const requestedAtEpochMs = now();
  const requestPath = join(snapshotDir, 'requests', `${nonce}.json`);
  const responsePath = join(snapshotDir, 'responses', `${nonce}.json`);
  const temporaryRequestPath = `${requestPath}.${crypto.randomUUID()}.part`;
  const timeoutMs = options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  try {
    await writeFile(
      temporaryRequestPath,
      JSON.stringify({ nonce, generation, requestedAtEpochMs }),
      {
        mode: 0o600,
      },
    );
    await rename(temporaryRequestPath, requestPath);
    return await waitForPGliteSnapshotResponse({
      snapshotDir,
      responsePath,
      nonce,
      generation,
      requestedAtEpochMs,
      deadline,
      timeoutMs,
      now,
    });
  } catch (error) {
    const operations = options.rejectionOperations ?? {
      publishCancellation: publishSnapshotCancellation,
      cleanupArtifacts: cleanupSnapshotArtifacts,
    };
    const results = await Promise.allSettled([
      operations.publishCancellation(snapshotDir, nonce),
      operations.cleanupArtifacts(snapshotDir, nonce),
    ]);
    const cleanupFailures = results.flatMap((result) =>
      result.status === 'rejected' && !isNotFoundError(result.reason as NodeJS.ErrnoException)
        ? [result.reason]
        : [],
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'PGlite snapshot request failed and its rejection cleanup also failed.',
      );
    }
    throw error;
  }
}

interface WaitForPGliteSnapshotResponseInput {
  readonly snapshotDir: string;
  readonly responsePath: string;
  readonly nonce: string;
  readonly generation: string;
  readonly requestedAtEpochMs: number;
  readonly deadline: number;
  readonly timeoutMs: number;
  readonly now: () => number;
}

async function waitForPGliteSnapshotResponse(
  input: WaitForPGliteSnapshotResponseInput,
): Promise<Readonly<{ path: string; cleanup(): Promise<void> }>> {
  while (input.now() <= input.deadline) {
    const response = await readSnapshotResponse(input.responsePath);
    if (!response) {
      await waitForSnapshotPoll();
      continue;
    }
    validateSnapshotResponse(response, input);
    const snapshotFile = `${input.nonce}.tar`;
    return {
      path: join(input.snapshotDir, 'snapshots', snapshotFile),
      cleanup: async () => await cleanupSnapshotArtifacts(input.snapshotDir, input.nonce),
    };
  }
  throw new Error(`Timed out waiting ${input.timeoutMs}ms for a PGlite evidence snapshot.`);
}

function validateSnapshotResponse(
  response: SnapshotResponse,
  input: WaitForPGliteSnapshotResponseInput,
): void {
  if (
    response.nonce !== input.nonce ||
    response.generation !== input.generation ||
    response.requestedAtEpochMs !== input.requestedAtEpochMs ||
    response.publishedAtEpochMs <= input.requestedAtEpochMs
  ) {
    throw new Error('PGlite snapshot publisher returned a stale or mismatched snapshot response.');
  }
  if (response.failure) throw new Error(`PGlite snapshot publisher failed: ${response.failure}`);
  if (response.snapshotFile !== `${input.nonce}.tar`) {
    throw new Error(
      'PGlite snapshot publisher returned an archive other than the exact nonce archive.',
    );
  }
}

function isNotFoundError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT';
}

async function publishSnapshotCancellation(snapshotDir: string, nonce: string): Promise<void> {
  const directory = join(snapshotDir, 'cancellations');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${nonce}.json`);
  const temporary = `${path}.${crypto.randomUUID()}.part`;
  try {
    await writeFile(temporary, JSON.stringify({ nonce }), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function cleanupSnapshotArtifacts(snapshotDir: string, nonce: string): Promise<void> {
  await Promise.all([
    removeSnapshotArtifacts(join(snapshotDir, 'requests'), nonce),
    removeSnapshotArtifacts(join(snapshotDir, 'responses'), nonce),
    removeSnapshotArtifacts(join(snapshotDir, 'snapshots'), nonce),
  ]);
}

async function removeSnapshotArtifacts(directory: string, nonce: string): Promise<void> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  await Promise.all(
    names
      .filter((name) => name.startsWith(nonce))
      .map(async (name) => await rm(join(directory, name), { force: true })),
  );
}

async function readSnapshotResponse(path: string): Promise<SnapshotResponse | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SnapshotResponse;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

const PGLITE_SNAPSHOT_READER_PATH =
  'packages/shared-test/black-box-runner/state-write-evidence/' +
  'read-pglite-black-box-evidence.mts';

async function runPGliteSnapshotReader(
  snapshotPath: string,
  input: unknown,
): Promise<ApiV1StateWriteEvidence> {
  const output = await runBoundedPGliteReaderCommand(
    process.execPath,
    [
      'run',
      '--quiet',
      '--config',
      'apps/api-v1/deno.json',
      '--allow-read',
      PGLITE_SNAPSHOT_READER_PATH,
      snapshotPath,
      JSON.stringify(input),
    ],
    {
      timeoutMs: SNAPSHOT_READER_TIMEOUT_MS,
      maxOutputBytes: SNAPSHOT_READER_MAX_OUTPUT_BYTES,
    },
  );
  return JSON.parse(output) as ApiV1StateWriteEvidence;
}

interface PGliteReaderOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly afterClose?: () => void;
}

export function runBoundedPGliteReaderCommand(
  command: string,
  args: readonly string[],
  options: PGliteReaderOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let failure: Error | undefined;
    const terminate = (error: Error): void => {
      if (failure) {
        return;
      }
      failure = error;
      try {
        child.kill('SIGKILL');
      } catch (_error) {
        // The close event still settles spawn and exit failures.
      }
    };
    const appendOutput = (chunk: string, target: 'stdout' | 'stderr'): void => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > options.maxOutputBytes) {
        terminate(
          new Error(`PGlite snapshot reader exceeded ${options.maxOutputBytes} output bytes.`),
        );
        return;
      }
      if (target === 'stdout') {
        stdout += chunk;
      } else {
        stderr += chunk;
      }
    };
    const timeout = setTimeout(() => {
      terminate(new Error(`PGlite snapshot reader timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      appendOutput(chunk, 'stdout');
    });
    child.stderr.on('data', (chunk: string) => {
      appendOutput(chunk, 'stderr');
    });
    child.once('error', terminate);
    child.once('close', (code) => {
      clearTimeout(timeout);
      options.afterClose?.();
      const closeFailure = toPGliteReaderCloseFailure(code, failure, stderr);
      if (closeFailure) {
        reject(closeFailure);
      } else {
        resolve(stdout);
      }
    });
  });
}

function toPGliteReaderCloseFailure(
  code: number | null,
  failure: Error | undefined,
  stderr: string,
): Error | undefined {
  if (failure || code === 0) return failure;
  return new Error(`PGlite snapshot reader exited ${code ?? 'without a code'}: ${stderr}`);
}

function waitForSnapshotPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
