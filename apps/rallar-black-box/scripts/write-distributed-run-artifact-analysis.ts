import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    computeDistributedRunArtifactAnalysis,
    type DistributedRunArtifactAnalysis,
    type DistributedRunArtifactFiles,
    type DistributedRunArtifactRejection
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type { Either } from '@shared/resilience/Either.ts';

export interface WriteDistributedRunArtifactAnalysisInput {
    readonly artifactDir: string;
    readonly outDir: string;
    readonly generatedAtEpochMs: number;
}

async function main(): Promise<void> {
    const args = toCommandLineOptions(process.argv.slice(2));
    const artifactDir = args['artifact-dir'];
    if (!artifactDir) {
        console.error('Missing required --artifact-dir <path>.');
        process.exitCode = 1;
        return;
    }
    const analyzed = await writeDistributedRunArtifactAnalysis({
        artifactDir,
        outDir: args['out-dir'] ?? join(artifactDir, 'analysis'),
        generatedAtEpochMs: Date.now()
    });
    if (analyzed.left !== undefined) {
        console.error(analyzed.left.message);
        process.exitCode = 1;
    }
}

export async function writeDistributedRunArtifactAnalysis(
    input: WriteDistributedRunArtifactAnalysisInput
): Promise<Either<DistributedRunArtifactRejection, DistributedRunArtifactAnalysis>> {
    const files = await readArtifactFiles(input.artifactDir);
    const analyzed = computeDistributedRunArtifactAnalysis({
        files,
        generatedAtEpochMs: input.generatedAtEpochMs
    });
    if (analyzed.right !== undefined) {
        await writeAnalysisFiles(input.outDir, analyzed.right);
    }
    return analyzed;
}

async function writeAnalysisFiles(outDir: string, artifactAnalysis: DistributedRunArtifactAnalysis): Promise<void> {
    const analysis = artifactAnalysis.analysis;
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
    await writeFile(join(outDir, 'summary.md'), analysis.summaryMarkdown);
    if (!analysis.ok) {
        await writeFile(join(outDir, 'fix-proposal.md'), analysis.fixProposalMarkdown);
    }
    if (artifactAnalysis.variant === 'distributed-run' && artifactAnalysis.analysis.performanceMarkdown !== undefined) {
        await writeFile(join(outDir, 'performance.md'), artifactAnalysis.analysis.performanceMarkdown);
    }
}

async function readArtifactFiles(artifactDir: string): Promise<DistributedRunArtifactFiles> {
    const entries = await readdir(artifactDir, { withFileTypes: true });
    const files: Record<string, string> = {};
    await Promise.all(
        entries
            .filter((entry) => entry.isFile())
            .map(async (entry) => {
                files[entry.name] = await readFile(join(artifactDir, entry.name), 'utf8');
            })
    );
    return files;
}

function toCommandLineOptions(args: readonly string[]): Record<string, string | undefined> {
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
        else {
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
