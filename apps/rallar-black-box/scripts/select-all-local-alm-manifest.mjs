import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const authoredAlmPaths = new Map([
    [6, 'apps/rallar-black-box/manifests/hetzner/diagnostic/alm-conformance-6-agent-30s.json'],
    [11, 'apps/rallar-black-box/manifests/hetzner/diagnostic/alm-conformance-11-agent-30s.json'],
    [15, 'apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json'],
    [30, 'apps/rallar-black-box/manifests/hetzner/20-alm-conformance-30-agent-30s.json'],
    [50, 'apps/rallar-black-box/manifests/hetzner/21-alm-conformance-50-agent-30s.json']
]);

export function selectAllLocalAlmManifest(input) {
    const count = Number(input.targetAgentCount);
    const path = authoredAlmPaths.get(count);
    if (
        path === undefined || input.targetAgentCount !== String(count) || input.manifestPath !== path ||
        input.browserEngine !== 'chromium' || input.registerBeforeLogin !== 'true'
    ) {
        throw new Error('All-local ALM selection requires one authored path/count, Chromium and registration.');
    }
    return { path, participantCount: count, playerCount: count - 1, meshMinSize: count + 1 };
}

export async function admitAllLocalAlmManifest(input) {
    const selection = selectAllLocalAlmManifest(input);
    if (typeof input.storageDir !== 'string' || input.storageDir.length === 0) {
        throw new Error('All-local ALM recorder storage is required.');
    }
    const [{ createAlmScaleDiagnosticEntries, createAlmScaleManifestEntries }, { decodeDistributedRunManifest }] =
        await Promise.all([
            import('../src/hetzner/create-alm-scale-manifest-entries.ts'),
            import('../../../packages/shared-test/rallar-bb-test/distributed-run-validation.ts')
        ]);
    const authored = [...createAlmScaleManifestEntries(), ...createAlmScaleDiagnosticEntries()]
        .find((entry) => entry.filePath === selection.path && entry.agentCount === selection.participantCount);
    const source = await readFile(path.join(input.repositoryRoot ?? process.cwd(), selection.path));
    if (authored === undefined || source.toString('utf8') !== `${JSON.stringify(authored.manifest, null, 2)}\n`) {
        throw new Error('Selected ALM source does not match its canonical producer.');
    }
    const decoded = decodeDistributedRunManifest(JSON.parse(source.toString('utf8')));
    if (
        decoded.right === undefined ||
        decoded.right.targetPolicy.expectedParticipantCount !== selection.participantCount ||
        decoded.right.groupAssertions.length !== 231
    ) {
        throw new Error('Selected ALM source is not the complete canonical cohort.');
    }
    await mkdir(input.storageDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(input.storageDir, 'source-manifest.json'), source, { flag: 'wx', mode: 0o400 });
    return selection;
}

if (process.argv[1]?.endsWith('/select-all-local-alm-manifest.mjs')) {
    try {
        const input = {
            manifestPath: process.env.MANIFEST_PATH,
            targetAgentCount: process.env.TARGET_AGENT_COUNT,
            browserEngine: process.env.BROWSER_ENGINE,
            registerBeforeLogin: process.env.REGISTER_BEFORE_LOGIN,
            storageDir: process.env.RALLAR_BLACK_BOX_STORAGE_DIR
        };
        const selection = process.argv.includes('--admit')
            ? await admitAllLocalAlmManifest(input)
            : selectAllLocalAlmManifest(input);
        if (!process.argv.includes('--admit') && process.env.GITHUB_ENV !== undefined) {
            appendFileSync(process.env.GITHUB_ENV, `ALM_MESH_MIN_SIZE=${selection.meshMinSize}\n`);
        }
    }
    catch {
        process.exitCode = 1;
    }
}
