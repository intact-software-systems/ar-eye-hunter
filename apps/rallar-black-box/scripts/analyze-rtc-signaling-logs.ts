import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    analyzeRtcSignalingTraceLogs,
    type RtcSignalingTraceAnalysis,
} from '@shared-test/rallar-bb-test/rtc-signaling-trace-analysis.ts';

const SHARD_LOG_FILE_NAME = '7_Run headless worker shard.txt';

export async function analyzeRtcSignalingLogDirectory(
    logsDir: string,
    outDir: string,
): Promise<RtcSignalingTraceAnalysis> {
    const logFiles = await findShardLogs(logsDir);
    const contents = await Promise.all(
        logFiles.map((file) => readFile(file, 'utf8')),
    );
    const analysis = analyzeRtcSignalingTraceLogs(contents.join('\n'));
    if (analysis.events === 0) {
        throw new Error(
            `No RTC signaling trace events found in ${logFiles.length} shard log files under ${logsDir}.`,
        );
    }

    await mkdir(outDir, { recursive: true });
    await writeFile(
        join(outDir, 'analysis.json'),
        `${JSON.stringify(analysis, null, 2)}\n`,
    );
    await writeFile(join(outDir, 'summary.md'), analysis.markdown);
    return analysis;
}

async function findShardLogs(directory: string): Promise<string[]> {
    const result: string[] = [];
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) {
            result.push(...await findShardLogs(child));
        } else if (entry.isFile() && entry.name === SHARD_LOG_FILE_NAME) {
            result.push(child);
        }
    }
    return result.sort();
}

function parseArgs(args: readonly string[]): Record<string, string | undefined> {
    const parsed: Record<string, string | undefined> = {};
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!arg.startsWith('--')) {
            continue;
        }
        const key = arg.slice(2);
        const next = args[index + 1];
        if (next && !next.startsWith('--')) {
            parsed[key] = next;
            index += 1;
        }
    }
    return parsed;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const logsDir = args['logs-dir'];
    const outDir = args['out-dir'];
    if (!logsDir || !outDir) {
        throw new Error('Usage: --logs-dir <path> --out-dir <path>');
    }
    await analyzeRtcSignalingLogDirectory(logsDir, outDir);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
