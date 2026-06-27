import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    analyzeDistributedRunArtifactFiles,
    type DistributedRunArtifactFiles,
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const artifactDir = args['artifact-dir'];
    if (!artifactDir) {
        throw new Error('Missing required --artifact-dir <path>.');
    }
    const outDir = args['out-dir'] ?? join(artifactDir, 'analysis');
    await analyzeDistributedRunArtifactDirectory(artifactDir, outDir);
}

export async function analyzeDistributedRunArtifactDirectory(
    artifactDir: string,
    outDir = join(artifactDir, 'analysis'),
): Promise<void> {
    const files = await readArtifactFiles(artifactDir);
    const analysis = analyzeDistributedRunArtifactFiles({ files });

    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
    await writeFile(join(outDir, 'summary.md'), analysis.summaryMarkdown);
    if (analysis.fixProposalMarkdown) {
        await writeFile(join(outDir, 'fix-proposal.md'), analysis.fixProposalMarkdown);
    }
    if (analysis.performanceMarkdown) {
        await writeFile(join(outDir, 'performance.md'), analysis.performanceMarkdown);
    }
}

async function readArtifactFiles(artifactDir: string): Promise<DistributedRunArtifactFiles> {
    const entries = await readdir(artifactDir, { withFileTypes: true });
    const files: Record<string, string> = {};
    await Promise.all(entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
            files[entry.name] = await readFile(join(artifactDir, entry.name), 'utf8');
        }));
    return files;
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
        } else {
            parsed[key] = '1';
        }
    }
    return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
