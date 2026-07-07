import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorldFleetDistributedManifestCatalog } from '../src/world-fleet-distributed-manifests.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

async function main(): Promise<void> {
    const catalog = buildWorldFleetDistributedManifestCatalog();
    const mismatches: string[] = [];

    for (const entry of catalog) {
        const absolutePath = path.join(repoRoot, entry.filePath);
        const json = `${JSON.stringify(entry.manifest, null, 2)}\n`;

        if (checkOnly) {
            const current = await readFile(absolutePath, 'utf8').catch(() => undefined);
            if (current !== json) {
                mismatches.push(entry.filePath);
            }
            continue;
        }

        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, json);
        console.log(`wrote ${entry.filePath}`);
    }

    if (mismatches.length > 0) {
        console.error('World-fleet distributed manifest JSON is out of date:');
        for (const filePath of mismatches) {
            console.error(`- ${filePath}`);
        }
        console.error('Run: npx tsx apps/rallar-black-box/scripts/write-world-fleet-distributed-manifests.ts');
        process.exitCode = 1;
        return;
    }

    if (checkOnly) {
        console.log(`checked ${catalog.length} world-fleet distributed manifest(s)`);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
