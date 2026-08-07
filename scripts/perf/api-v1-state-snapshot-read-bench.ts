import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
  createClientRestSnapshotReadSelector,
} from '@shared-server/rallar-system/client-state/snapshot/client-rest-snapshot-read-selector.ts';
import {
  createGroupRestSnapshotReadSelector,
} from '@shared-server/rallar-system/group-state/snapshot/group-rest-snapshot-read-selector.ts';

const ITERATIONS = readPositiveInteger('--iterations', 1_000);
const CONCURRENCY = readPositiveInteger('--concurrency', 32);
const OUT = readArgument('--out') ??
  'tmp/perf/results/api-v1-state-snapshot-read.json';
if (!OUT.startsWith('tmp/perf/') || OUT.includes('/../')) {
  throw new Error(`Benchmark output must remain under tmp/perf/: ${OUT}`);
}

interface ScenarioResult {
  readonly name: string;
  readonly operations: number;
  readonly durableReads: number;
  readonly cacheReads: number;
  readonly latencyMs: Readonly<{ p50: number; p95: number; p99: number }>;
}

interface ClientScenarioInput {
  readonly name: string;
  readonly floor?: number;
  readonly durableRevision: number;
  readonly cachedRevision?: number;
}

const clientRef = {
  applicationId: 'perf-app',
  workspaceId: 'perf-workspace',
  principalId: 'perf-client',
};
const groupRef = {
  applicationId: 'perf-app',
  workspaceId: 'perf-workspace',
  groupId: 'perf-group',
};
const results = [
  await runClientScenario({ name: 'tokenless-durable', durableRevision: 10 }),
  await runClientScenario({ name: 'eligible-cache', floor: 10, durableRevision: 10 }),
  await runClientScenario({
    name: 'below-floor-fallback',
    floor: 11,
    durableRevision: 11,
    cachedRevision: 10,
  }),
  await runStrictGroupScenario(),
  await runConcurrentClientScenario(),
];

await Deno.mkdir(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true });
await Deno.writeTextFile(
  OUT,
  `${
    JSON.stringify(
      {
        benchmark: 'api-v1-state-snapshot-read',
        createdAt: new Date().toISOString(),
        inputs: { iterations: ITERATIONS, concurrency: CONCURRENCY },
        numericSlo: null,
        results,
      },
      null,
      2,
    )
  }\n`,
);
console.log(`Wrote ${OUT}`);

async function runClientScenario(input: ClientScenarioInput): Promise<ScenarioResult> {
  const floor = input.floor;
  const cachedRevision = input.cachedRevision ?? input.durableRevision;
  let durableReads = 0;
  let cacheReads = 0;
  let cached = floor === undefined ? undefined : clientSnapshot(cachedRevision);
  const selector = createClientRestSnapshotReadSelector({
    durable: {
      readSnapshot: async () => {
        durableReads += 1;
        return clientSnapshot(input.durableRevision);
      },
    },
    cache: {
      peek: () => {
        cacheReads += 1;
        return cached;
      },
      observe: (snapshot) => {
        if (cachedRevision >= (floor ?? 0)) cached = snapshot;
        return 'advanced';
      },
      evictIfUnchanged: () => false,
    },
  });
  const samples = await measure(
    ITERATIONS,
    async () => {
      await selector.read(clientRef, floor === undefined ? {} : { minStateRevision: floor });
    },
  );
  return summarize({ name: input.name, samples, durableReads, cacheReads });
}

async function runStrictGroupScenario(): Promise<ScenarioResult> {
  let durableReads = 0;
  let cacheReads = 0;
  const snapshot = groupSnapshot(10, 4);
  const selector = createGroupRestSnapshotReadSelector({
    durable: {
      readSnapshot: async () => {
        durableReads += 1;
        return snapshot;
      },
    },
    cache: {
      peek: () => {
        cacheReads += 1;
        return snapshot;
      },
      observe: () => 'duplicate',
      evictIfUnchanged: () => false,
    },
  });
  const samples = await measure(ITERATIONS, async () => {
    await selector.read(groupRef, {
      minCausalRevision: { groupRevision: 10, presenceRevision: 4 },
      strictMode: true,
    });
  });
  return summarize({ name: 'strict-auth-group', samples, durableReads, cacheReads });
}

async function runConcurrentClientScenario(): Promise<ScenarioResult> {
  let durableReads = 0;
  let cacheReads = 0;
  const snapshot = clientSnapshot(20);
  const selector = createClientRestSnapshotReadSelector({
    durable: {
      readSnapshot: async () => {
        durableReads += 1;
        return snapshot;
      },
    },
    cache: {
      peek: () => {
        cacheReads += 1;
        return snapshot;
      },
      observe: () => 'duplicate',
      evictIfUnchanged: () => false,
    },
  });
  const samples: number[] = [];
  for (let offset = 0; offset < ITERATIONS; offset += CONCURRENCY) {
    const batchSize = Math.min(CONCURRENCY, ITERATIONS - offset);
    samples.push(
      ...await Promise.all(Array.from({ length: batchSize }, async () => {
        const startedAt = performance.now();
        await selector.read(clientRef, { minStateRevision: 20 });
        return performance.now() - startedAt;
      })),
    );
  }
  return summarize({
    name: 'eligible-cache-concurrent',
    samples,
    durableReads,
    cacheReads,
  });
}

async function measure(
  operations: number,
  operation: () => Promise<void>,
): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < operations; index += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

function summarize(
  input: Readonly<{
    name: string;
    samples: readonly number[];
    durableReads: number;
    cacheReads: number;
  }>,
): ScenarioResult {
  return {
    name: input.name,
    operations: input.samples.length,
    durableReads: input.durableReads,
    cacheReads: input.cacheReads,
    latencyMs: {
      p50: percentile(input.samples, 0.5),
      p95: percentile(input.samples, 0.95),
      p99: percentile(input.samples, 0.99),
    },
  };
}

function percentile(samples: readonly number[], value: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? 0;
}

function clientSnapshot(stateRevision: number): ClientSnapshot {
  return { stateRevision } as ClientSnapshot;
}

function groupSnapshot(groupRevision: number, presenceRevision: number): GroupSnapshot {
  return {
    stateRevision: groupRevision + presenceRevision,
    causalRevision: { groupRevision, presenceRevision },
  } as GroupSnapshot;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(readArgument(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function readArgument(name: string): string | undefined {
  return Deno.args.find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
