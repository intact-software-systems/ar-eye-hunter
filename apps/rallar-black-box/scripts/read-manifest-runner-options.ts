import type { WorldFleetDistributedRecipeRunnerOptions } from './run-world-fleet-distributed-recipe.ts';

export function readManifestRunnerOptions(
    args: readonly string[],
    env: NodeJS.ProcessEnv
): WorldFleetDistributedRecipeRunnerOptions {
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        }
        if (!arg.startsWith('--')) {
            throw new Error(`Unexpected argument: ${arg}`);
        }
        const key = arg.slice(2);
        const value = args[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`Missing value for --${key}`);
        }
        values.set(key, value);
        index += 1;
    }

    const controlBaseUrl = values.get('control') ?? env.RALLAR_CONTROL_BASE_URL;
    const manifestPath = values.get('manifest');
    if (!controlBaseUrl || !manifestPath) {
        printUsage();
        throw new Error('Missing --control and/or --manifest.');
    }

    return {
        controlBaseUrl,
        manifestPath,
        controlRunId: values.get('control-run-id') ?? env.RALLAR_CONTROL_RUN_ID,
        token: values.get('token') ?? env.RALLAR_CONTROL_ADMIN_TOKEN,
        artifactDir: values.get('artifact-dir'),
        pollMs: positiveInteger(values.get('poll-ms'), 2_000),
        timeoutMs: positiveInteger(values.get('timeout-ms'), 30 * 60_000)
    };
}

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printUsage(): void {
    console.log(`Usage:
  npx tsx apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts \\
    --control http://127.0.0.1:5180 \\
    --manifest apps/rallar-black-box/manifests/world-fleet/01-rtc-messages-principal-50-agent-30s-20hz-tree.json \\
    --control-run-id live-world-fleet-control-run \\
    --token "$RALLAR_CONTROL_ADMIN_TOKEN" \\
    --artifact-dir artifacts/world-fleet/principal-30s-tree \\
    --timeout-ms 3900000

This runner never starts, stops, installs, or restarts headless agents. It only
preflights, creates, stages, starts, polls, and exports through an existing
control server.`);
}
