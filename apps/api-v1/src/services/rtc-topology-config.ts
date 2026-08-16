import type { RallarRtcTopologyServiceOptions } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import {
  DEFAULT_RTT_REFINEMENT_MIN_INTERVAL_MS,
  DEFAULT_RTT_VIVALDI_DELTA_MS,
  type RtcRttRefinementGateConfig,
} from '@shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-gate.ts';

type EnvReader = Readonly<{
  get(name: string): string | undefined;
}>;

export function getApiRtcTopologyServiceOptions(
  env: EnvReader = Deno.env,
): RallarRtcTopologyServiceOptions {
  return compactOptions({
    degreeLimit: readPositiveIntegerEnv(env, 'RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT'),
    rttReportingDegreeLimit: readPositiveIntegerEnv(
      env,
      'RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT',
    ),
    treeMinSize: readPositiveIntegerEnv(env, 'RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE'),
    meshMinSize: readPositiveIntegerEnv(env, 'RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE'),
    meshParamK: readPositiveIntegerEnv(env, 'RALLAR_RTC_TOPOLOGY_MESH_PARAM_K'),
    meshExitWidth: readNonNegativeIntegerEnv(env, 'RALLAR_RTC_TOPOLOGY_MESH_EXIT_WIDTH'),
    treeExitWidth: readNonNegativeIntegerEnv(env, 'RALLAR_RTC_TOPOLOGY_TREE_EXIT_WIDTH'),
    rttRebuildDebounceMs: readNonNegativeIntegerEnv(
      env,
      'RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS',
    ),
  });
}

export function readApiTopologyRecomputeDebounceMs(
  env: EnvReader = Deno.env,
): number | undefined {
  return readNonNegativeIntegerEnv(env, 'RALLAR_RTC_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS');
}

export function readApiGlobalGraphRecomputeLimit(
  env: EnvReader = Deno.env,
): Readonly<{ windowMs: number; maxPerWindow: number }> | undefined {
  const windowMs = readPositiveIntegerEnv(
    env,
    'RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTE_WINDOW_MS',
  );
  const maxPerWindow = readPositiveIntegerEnv(
    env,
    'RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTES_PER_WINDOW',
  );
  return windowMs !== undefined && maxPerWindow !== undefined
    ? { windowMs, maxPerWindow }
    : undefined;
}

export function readApiRtcRttRefinementGateConfig(
  env: EnvReader = Deno.env,
): Omit<RtcRttRefinementGateConfig, 'now'> {
  return {
    minIntervalMs: readNonNegativeIntegerEnv(
      env,
      'RALLAR_RTC_TOPOLOGY_RTT_REFINEMENT_MIN_INTERVAL_MS',
    ) ?? DEFAULT_RTT_REFINEMENT_MIN_INTERVAL_MS,
    vivaldiDeltaThresholdMs: readNonNegativeIntegerEnv(
      env,
      'RALLAR_RTC_TOPOLOGY_RTT_VIVALDI_DELTA_MS',
    ) ?? DEFAULT_RTT_VIVALDI_DELTA_MS,
  };
}

function compactOptions(
  options: Omit<RallarRtcTopologyServiceOptions, 'now'>,
): RallarRtcTopologyServiceOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([_key, value]) => value !== undefined),
  ) as RallarRtcTopologyServiceOptions;
}

function readPositiveIntegerEnv(env: EnvReader, name: string): number | undefined {
  const value = readIntegerEnv(env, name);
  return value !== undefined && value > 0 ? value : undefined;
}

function readNonNegativeIntegerEnv(env: EnvReader, name: string): number | undefined {
  const value = readIntegerEnv(env, name);
  return value !== undefined && value >= 0 ? value : undefined;
}

function readIntegerEnv(env: EnvReader, name: string): number | undefined {
  const raw = env.get(name)?.trim();
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}
