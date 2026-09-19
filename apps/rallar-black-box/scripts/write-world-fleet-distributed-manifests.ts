import { toError } from '@shared/resilience/to-error.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorldFleetDistributedManifestEntry } from '../src/world-fleet-distributed-manifests.ts';
import { createWorldFleetDistributedManifestCatalog } from '../src/world-fleet-distributed-manifests.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function toManifestJson(entry: WorldFleetDistributedManifestEntry): string {
    return `${JSON.stringify(entry.manifest, null, 2)}\n`;
}

async function writeManifestFiles(
    catalog: readonly WorldFleetDistributedManifestEntry[]
): Promise<void> {
    for (const entry of catalog) {
        const absolutePath = path.join(repoRoot, entry.filePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, toManifestJson(entry));
        console.log(`wrote ${entry.filePath}`);
    }
}

async function readOutdatedManifestPaths(
    catalog: readonly WorldFleetDistributedManifestEntry[]
): Promise<readonly string[]> {
    const outdated: string[] = [];
    for (const entry of catalog) {
        const absolutePath = path.join(repoRoot, entry.filePath);
        const current = await readFile(absolutePath, 'utf8').catch(() => undefined);
        if (current !== toManifestJson(entry)) {
            outdated.push(entry.filePath);
        }
    }
    return outdated;
}

async function runWorldFleetDistributedManifestCli(): Promise<void> {
    const catalog = createWorldFleetDistributedManifestCatalog();
    if (!new Set(process.argv.slice(2)).has('--check')) {
        await writeManifestFiles(catalog);
        return;
    }

    const outdated = await readOutdatedManifestPaths(catalog);
    if (outdated.length === 0) {
        console.log(`checked ${catalog.length} world-fleet distributed manifest(s)`);
        return;
    }

    console.error('World-fleet distributed manifest JSON is out of date:');
    for (const filePath of outdated) {
        console.error(`- ${filePath}`);
    }
    console.error('Run: npx tsx apps/rallar-black-box/scripts/write-world-fleet-distributed-manifests.ts');
    process.exitCode = 1;
}

try {
    await runWorldFleetDistributedManifestCli();
}
catch (error) {
    console.error(toError(error).message);
    process.exitCode = 1;
}
