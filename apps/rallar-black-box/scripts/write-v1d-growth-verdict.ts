import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeV1dGrowthRun } from '@shared-test/rallar-bb-test/alm/growth-proof/decode-v1d-growth-run.ts';
import { toV1dGrowthVerdictMarkdown } from '@shared-test/rallar-bb-test/alm/growth-proof/to-v1d-growth-verdict-markdown.ts';
import {
    V1D_GROWTH_SURFACES,
    V1D_GROWTH_SURVEY_SURFACE_IDS
} from '@shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-surfaces.ts';
import { computeV1dGrowthVerdict } from '@shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-verdict.ts';
import { toError } from '@shared/resilience/to-error.ts';

/** Reads a growth-proof run directory, writes `verdict.md` and `verdict.json` beside it, and exits 1 unless it passed. */
async function writeV1dGrowthVerdict(runDir: string): Promise<boolean> {
    const decoded = decodeV1dGrowthRun({
        runJson: await readRunFile(runDir, 'run.json'),
        postgres: await readRunFile(runDir, 'samples/postgres.jsonl'),
        adminSystem: await readRunFile(runDir, 'samples/admin-system.jsonl'),
        adminQueues: await readRunFile(runDir, 'samples/admin-queues.jsonl'),
        adminRealtime: await readRunFile(runDir, 'samples/admin-realtime.jsonl'),
        processRss: await readRunFile(runDir, 'samples/process-rss.jsonl'),
        controlRun: await readRunFile(runDir, 'samples/control-run.jsonl'),
        apiTimingLog: await readRunFile(runDir, 'api-timing.log')
    });
    if (decoded.right === undefined) {
        throw new Error(`The run directory does not decode: ${(decoded.left ?? []).join('; ')}`);
    }
    const verdict = computeV1dGrowthVerdict({
        surveyedSurfaceIds: V1D_GROWTH_SURVEY_SURFACE_IDS,
        surfaces: V1D_GROWTH_SURFACES,
        run: decoded.right.run,
        samples: decoded.right.samples
    });
    const markdown = toV1dGrowthVerdictMarkdown({ verdict, skippedLines: decoded.right.skippedLines });
    await writeFile(join(runDir, 'verdict.md'), markdown);
    await writeFile(join(runDir, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
    console.log(markdown.split('\n').slice(0, 3).join('\n'));
    console.log(`wrote ${join(runDir, 'verdict.md')}`);
    return verdict.passed;
}

/** A sampler that never wrote a file leaves its readings absent, which the verdict reports as no data. */
async function readRunFile(runDir: string, fileName: string): Promise<string> {
    return await readFile(join(runDir, fileName), 'utf8').catch(() => '');
}

function readRunDirArgument(args: readonly string[]): string {
    const index = args.indexOf('--run-dir');
    const runDir = index === -1 ? undefined : args[index + 1];
    if (runDir === undefined || runDir.startsWith('--')) {
        throw new Error('Usage: npx tsx apps/rallar-black-box/scripts/write-v1d-growth-verdict.ts --run-dir <dir>');
    }
    return runDir;
}

try {
    const passed = await writeV1dGrowthVerdict(readRunDirArgument(process.argv.slice(2)));
    process.exitCode = passed ? 0 : 1;
}
catch (error) {
    console.error(toError(error).message);
    process.exitCode = 2;
}
