import {
  createConsoleRallarTimingSink,
  type RallarTimingSink,
} from '@shared-server/rallar-system/services/timing.ts';

let timingSink: RallarTimingSink | undefined;

export function getApiTimingSink(): RallarTimingSink {
  timingSink ??= createConsoleRallarTimingSink({
    enabled: readTimingEnabled(),
  });

  return timingSink;
}

function readTimingEnabled(): boolean {
  return (Deno.env.get('RALLAR_TIMING_LOGS') ?? 'true').toLowerCase() !== 'false';
}
