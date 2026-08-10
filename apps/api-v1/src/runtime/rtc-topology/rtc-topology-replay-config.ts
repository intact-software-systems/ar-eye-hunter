import type {
  ApiV1DatabaseBackendConfig,
  EnvReader,
} from '../../db/database-config.ts';
import { readApiV1DatabaseBackendConfig } from '../../db/database-config.ts';

export const RTC_TOPOLOGY_REPLAY_MODES = ['disabled', 'enabled'] as const;
export const API_QUEUE_WORKER_MODES = ['enabled', 'disabled'] as const;

export type RtcTopologyReplayMode = typeof RTC_TOPOLOGY_REPLAY_MODES[number];
export type ApiQueueWorkerMode = typeof API_QUEUE_WORKER_MODES[number];

export interface ApiRtcTopologyReplayConfig {
  readonly replay: RtcTopologyReplayMode;
  readonly queueWorkers: ApiQueueWorkerMode;
}

const RTC_TOPOLOGY_REPLAY_ENV = 'RALLAR_RTC_TOPOLOGY_REPLAY';
const API_QUEUE_WORKERS_ENV = 'RALLAR_API_QUEUE_WORKERS';

export function readApiRtcTopologyReplayConfig(
  env: EnvReader = Deno.env,
  databaseConfig: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig(env),
): ApiRtcTopologyReplayConfig {
  const config = {
    replay: readMode(
      env,
      RTC_TOPOLOGY_REPLAY_ENV,
      RTC_TOPOLOGY_REPLAY_MODES,
      'enabled',
    ),
    queueWorkers: readMode(
      env,
      API_QUEUE_WORKERS_ENV,
      API_QUEUE_WORKER_MODES,
      'enabled',
    ),
  };
  if (config.queueWorkers === 'disabled' && databaseConfig.sqlBackend !== 'postgres') {
    throw new Error(
      `${API_QUEUE_WORKERS_ENV}=disabled requires RALLAR_SQL_BACKEND=postgres. ` +
        `Configured backend: ${databaseConfig.sqlBackend}`,
    );
  }
  return config;
}

export function rtcTopologyReplayStartupLogLine(
  config: ApiRtcTopologyReplayConfig,
): string {
  return [
    `Rallar API-v1 RTC topology replay: ${config.replay};`,
    `queue workers: ${config.queueWorkers}`,
  ].join(' ');
}

export function logRtcTopologyReplayConfig(
  log: (message: string) => void = console.log,
  config: ApiRtcTopologyReplayConfig = readApiRtcTopologyReplayConfig(),
): void {
  log(rtcTopologyReplayStartupLogLine(config));
}

export function shouldStartApiQueueWorkers(config: ApiRtcTopologyReplayConfig): boolean {
  return config.queueWorkers === 'enabled';
}

function readMode<const T extends readonly string[]>(
  env: EnvReader,
  name: string,
  allowed: T,
  defaultValue: T[number],
): T[number] {
  const raw = env.get(name);
  if (raw === undefined) return defaultValue;
  const value = raw.trim();
  if (allowed.includes(value)) return value as T[number];
  throw new Error(`${name} must be one of ${allowed.join(', ')}. Received: ${value}`);
}
