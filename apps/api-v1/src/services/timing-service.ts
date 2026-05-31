import {
  createConsoleRallarTimingSink,
  type RallarTimingSink,
} from '@shared-server/rallar-system/services/timing.ts';
import type {
  AppInboxServiceOptions,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

let timingSink: RallarTimingSink | undefined;

export function getApiTimingSink(): RallarTimingSink {
  timingSink ??= createConsoleRallarTimingSink({
    enabled: readTimingEnabled(),
  });

  return timingSink;
}

export function getApiAppInboxServiceOptions(): AppInboxServiceOptions {
  return {
    phaseTiming: readBooleanEnv('RALLAR_APP_INBOX_PHASE_TIMING', false),
    waitMaxElapsedMsecs: readNumberEnv('RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS', 30_000),
    waitRetryIntervalMsecs: readNumberEnv('RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS', 250),
    waitMaxRetryIntervalMsecs: readNumberEnv('RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS', 1_000),
    waitJitterRatio: readNumberEnv('RALLAR_APP_INBOX_WAIT_JITTER_RATIO', 0.1),
  };
}

function readTimingEnabled(): boolean {
  return readBooleanEnv('RALLAR_TIMING_LOGS', true);
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function readNumberEnv(name: string, fallback: number): number {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
