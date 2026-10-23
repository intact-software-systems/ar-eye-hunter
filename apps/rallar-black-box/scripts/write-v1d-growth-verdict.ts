import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * A sampler that never wrote a file leaves its readings absent, which the verdict reports as no data. Any other read
 * failure, and a file past `maxBytes`, stops the verdict instead of reading as no data.
 */
export async function readV1dGrowthRunFile(runDir: string, fileName: string, maxBytes: number): Promise<string> {
    const filePath = path.join(runDir, fileName);
    const size = await readFileSize(filePath);
    if (size === undefined) {
        return '';
    }
    if (size > maxBytes) {
        throw new Error(`${filePath} holds ${size} bytes, past the ${maxBytes} the verdict reads whole`);
    }
    return await readFile(filePath, 'utf8');
}

/** Reads a growth-proof run directory, writes `verdict.md` and `verdict.json` beside it, and exits 1 unless it passed. */
async function writeV1dGrowthVerdict(runDir: string): Promise<boolean> {
    const decoded = decodeV1dGrowthRun({
        runJson: await readV1dGrowthRunFile(runDir, 'run.json', MAX_RUN_FILE_BYTES),
        postgres: await readV1dGrowthRunFile(runDir, 'samples/postgres.jsonl', MAX_RUN_FILE_BYTES),
        adminSystem: await readV1dGrowthRunFile(runDir, 'samples/admin-system.jsonl', MAX_RUN_FILE_BYTES),
        adminQueues: await readV1dGrowthRunFile(runDir, 'samples/admin-queues.jsonl', MAX_RUN_FILE_BYTES),
        adminRealtime: await readV1dGrowthRunFile(runDir, 'samples/admin-realtime.jsonl', MAX_RUN_FILE_BYTES),
        processRss: await readV1dGrowthRunFile(runDir, 'samples/process-rss.jsonl', MAX_RUN_FILE_BYTES),
        controlRun: await readV1dGrowthRunFile(runDir, 'samples/control-run.jsonl', MAX_RUN_FILE_BYTES),
        apiHeap: await readV1dGrowthRunFile(runDir, 'samples/api-heap.jsonl', MAX_RUN_FILE_BYTES)
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
    await writeFile(path.join(runDir, 'verdict.md'), markdown);
    await writeFile(path.join(runDir, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
    console.log(markdown.split('\n').slice(0, 3).join('\n'));
    console.log(`wrote ${path.join(runDir, 'verdict.md')}`);
    return verdict.passed;
}

/** Undefined for a file that does not exist. */
async function readFileSize(filePath: string): Promise<number | undefined> {
    try {
        return (await stat(filePath)).size;
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

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
    try {
        const passed = await writeV1dGrowthVerdict(readRunDirArgument(process.argv.slice(2)));
        process.exitCode = passed ? 0 : 1;
    }
    catch (error) {
        console.error(toError(error).message);
        process.exitCode = 2;
    }
}
