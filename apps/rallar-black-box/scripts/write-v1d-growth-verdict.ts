import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeV1dGrowthRun } from '@shared-test/rallar-bb-test/alm/growth-proof/decode-v1d-growth-run.ts';
import { toV1dGrowthVerdictMarkdown } from '@shared-test/rallar-bb-test/alm/growth-proof/to-v1d-growth-verdict-markdown.ts';
import {
    V1D_GROWTH_SURFACES,
    V1D_GROWTH_SURVEY_SURFACE_IDS
} from '@shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-surfaces.ts';
import { computeV1dGrowthVerdict } from '@shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-verdict.ts';
import { toError } from '@shared/resilience/to-error.ts';

/** Well inside the largest string V8 holds; a 75-minute run's largest sample file, its control polls, is 138 MB. */
const MAX_RUN_FILE_BYTES = 256 * 1024 * 1024;

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
        apiHeap: await readRunFile(runDir, 'samples/api-heap.jsonl')
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

/**
 * A sampler that never wrote a file leaves its readings absent, which the verdict reports as no data. Any other read
 * failure, and a file past the bound a whole read can hold, stops the verdict instead of reading as no data.
 */
async function readRunFile(runDir: string, fileName: string): Promise<string> {
    const path = join(runDir, fileName);
    const size = await readFileSize(path);
    if (size === undefined) {
        return '';
    }
    if (size > MAX_RUN_FILE_BYTES) {
        throw new Error(`${path} holds ${size} bytes, past the ${MAX_RUN_FILE_BYTES} the verdict reads whole`);
    }
    return await readFile(path, 'utf8');
}

/** Undefined for a file that does not exist. */
async function readFileSize(path: string): Promise<number | undefined> {
    try {
        return (await stat(path)).size;
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
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
