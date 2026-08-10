import { dirname } from 'node:path';
import postgres from 'postgres';

import {
  type BenchmarkSql,
  RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY,
  summarizeRtcTopologyDeliveryLatencies,
} from './delivery-log-benchmark-contracts.ts';
import {
  runRtcTopologyDeliveryLogWorkloads,
} from './run-rtc-topology-delivery-log-workloads.ts';

export {
  RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY,
  summarizeRtcTopologyDeliveryLatencies,
} from './delivery-log-benchmark-contracts.ts';

const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/appdb';

interface BenchmarkOptions {
  readonly outPath: string;
  readonly label: string;
}

async function main(): Promise<void> {
  const options = readOptions(Deno.args);
  const databaseUrl = Deno.env.get('DATABASE_URL') ?? DEFAULT_DATABASE_URL;
  const postgresDatabase = postgres(databaseUrl, {
    max: RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.concurrency + 2,
    idle_timeout: 2,
  });
  const database = postgresDatabase as typeof postgresDatabase & BenchmarkSql;
  try {
    const versionRows = await database<Readonly<{ version: string }>[]>`
      select current_setting('server_version') as version
    `;
    const workloads = await runRtcTopologyDeliveryLogWorkloads(database);
    const artifact = {
      schema: 'rallar.rtc-topology-delivery-log.v1',
      label: options.label,
      generatedAt: new Date().toISOString(),
      runtime: {
        deno: Deno.version.deno,
        postgres: versionRows[0]?.version ?? 'unavailable',
      },
      policy: RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY,
      workloads,
    };
    await Deno.mkdir(dirname(options.outPath), { recursive: true });
    await Deno.writeTextFile(options.outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(JSON.stringify({ outPath: options.outPath, workloads }, null, 2));
  } finally {
    await database.end();
  }
}

function readOptions(args: readonly string[]): BenchmarkOptions {
  let outPath = 'tmp/perf/rtc-topology-delivery-log.json';
  let label = 'candidate';
  for (const argument of args) {
    if (argument.startsWith('--out=')) outPath = argument.slice('--out='.length);
    else if (argument.startsWith('--label=')) label = argument.slice('--label='.length);
    else throw new TypeError(`Unsupported RTC topology delivery benchmark option: ${argument}`);
  }
  if (!outPath.trim() || !label.trim()) {
    throw new TypeError('RTC topology delivery benchmark output and label must be non-empty');
  }
  return { outPath, label };
}

if (import.meta.main) await main();
