import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { decodeGrowthRun } from '@shared-test/rallar-bb-test/alm/growth-proof/decode-growth-run.ts';
import {
    GROWTH_SURFACES,
    GROWTH_SURVEY_SURFACE_IDS
} from '@shared-test/rallar-bb-test/alm/growth-proof/growth-surfaces.ts';
import { computeGrowthVerdict } from '@shared-test/rallar-bb-test/alm/growth-proof/growth-verdict.ts';
import { toGrowthVerdictMarkdown } from '@shared-test/rallar-bb-test/alm/growth-proof/to-growth-verdict-markdown.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { readGrowthRunFile } from './read-growth-run-file.ts';

/** Well inside the largest string V8 holds; a 75-minute run's largest sample file, its control polls, is 138 MB. */
const MAX_RUN_FILE_BYTES = 256 * 1024 * 1024;

/** Reads a growth-proof run directory, writes `verdict.md` and `verdict.json` beside it, and exits 1 unless it passed. */
async function writeGrowthVerdict(runDir: string): Promise<boolean> {
    const decoded = decodeGrowthRun({
        runJson: await readGrowthRunFile(runDir, 'run.json', MAX_RUN_FILE_BYTES),
        postgres: await readGrowthRunFile(runDir, 'samples/postgres.jsonl', MAX_RUN_FILE_BYTES),
        adminSystem: await readGrowthRunFile(runDir, 'samples/admin-system.jsonl', MAX_RUN_FILE_BYTES),
        adminQueues: await readGrowthRunFile(runDir, 'samples/admin-queues.jsonl', MAX_RUN_FILE_BYTES),
        adminRealtime: await readGrowthRunFile(runDir, 'samples/admin-realtime.jsonl', MAX_RUN_FILE_BYTES),
        processRss: await readGrowthRunFile(runDir, 'samples/process-rss.jsonl', MAX_RUN_FILE_BYTES),
        controlRun: await readGrowthRunFile(runDir, 'samples/control-run.jsonl', MAX_RUN_FILE_BYTES),
        apiHeap: await readGrowthRunFile(runDir, 'samples/api-heap.jsonl', MAX_RUN_FILE_BYTES)
    });
    if (decoded.right === undefined) {
        throw new Error(`The run directory does not decode: ${(decoded.left ?? []).join('; ')}`);
    }
    const verdict = computeGrowthVerdict({
        surveyedSurfaceIds: GROWTH_SURVEY_SURFACE_IDS,
        surfaces: GROWTH_SURFACES,
        run: decoded.right.run,
        samples: decoded.right.samples
    });
    const markdown = toGrowthVerdictMarkdown({ verdict, skippedLines: decoded.right.skippedLines });
    await writeFile(path.join(runDir, 'verdict.md'), markdown);
    await writeFile(path.join(runDir, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
    console.log(markdown.split('\n').slice(0, 3).join('\n'));
    console.log(`wrote ${path.join(runDir, 'verdict.md')}`);
    return verdict.passed;
}

function readRunDirArgument(args: readonly string[]): string {
    const index = args.indexOf('--run-dir');
    const runDir = index === -1 ? undefined : args[index + 1];
    if (runDir === undefined || runDir.startsWith('--')) {
        throw new Error('Usage: npx tsx apps/rallar-black-box/scripts/write-growth-verdict.ts --run-dir <dir>');
    }
    return runDir;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    try {
        const passed = await writeGrowthVerdict(readRunDirArgument(process.argv.slice(2)));
        process.exitCode = passed ? 0 : 1;
    }
    catch (error) {
        console.error(toError(error).message);
        process.exitCode = 2;
    }
}
