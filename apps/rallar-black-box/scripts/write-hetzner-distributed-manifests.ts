import { toError } from '@shared/resilience/to-error.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHetznerDistributedManifestCatalog } from '../src/create-hetzner-distributed-manifest-catalog.ts';
import type { HetznerDistributedManifestEntry } from '../src/hetzner/hetzner-manifest-entry.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function toManifestJson(entry: HetznerDistributedManifestEntry): string {
    return `${JSON.stringify(entry.manifest, null, 2)}\n`;
}

async function writeManifestFiles(
    catalog: readonly HetznerDistributedManifestEntry[]
): Promise<void> {
    for (const entry of catalog) {
        const absolutePath = path.join(repoRoot, entry.filePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, toManifestJson(entry));
        console.log(`wrote ${entry.filePath}`);
    }
}

async function readOutdatedManifestPaths(
    catalog: readonly HetznerDistributedManifestEntry[]
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

async function runHetznerDistributedManifestCli(): Promise<void> {
    const catalog = createHetznerDistributedManifestCatalog();
    if (!new Set(process.argv.slice(2)).has('--check')) {
        await writeManifestFiles(catalog);
        return;
    }

    const outdated = await readOutdatedManifestPaths(catalog);
    if (outdated.length === 0) {
        console.log(`checked ${catalog.length} Hetzner distributed manifest(s)`);
        return;
    }

    console.error('Hetzner distributed manifest JSON is out of date:');
    for (const filePath of outdated) {
        console.error(`- ${filePath}`);
    }
    console.error('Run: npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts');
    process.exitCode = 1;
}

try {
    await runHetznerDistributedManifestCli();
}
catch (error) {
    console.error(toError(error).message);
    process.exitCode = 1;
}
