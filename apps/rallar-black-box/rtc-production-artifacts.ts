import { createHash } from 'node:crypto';
import {
    lstat,
    readdir,
    readFile,
    realpath
} from 'node:fs/promises';
import {
    isAbsolute,
    relative,
    resolve,
    sep
} from 'node:path';

import type {
    FullStackRtcProductionBinding,
    FullStackRtcProductionFile,
    FullStackRtcProductionInput
} from '../../packages/shared-test/black-box-runner/fixtures/rtc-production/full-stack-rtc-production-proof.ts';
import { Either } from '../../packages/shared/resilience/Either.ts';

export async function readProductionOwner(
    repoRoot: string,
    buildRoot: string,
    owner: Pick<FullStackRtcProductionBinding, 'baselineId' | 'attempt'>
): Promise<void> {
    await readConfinedProductionPath(repoRoot, buildRoot, 'directory');
    await readConfinedProductionPath(repoRoot, resolve(buildRoot, 'output'), 'directory');
    await readConfinedProductionPath(repoRoot, resolve(buildRoot, 'owner.json'), 'file');
    if (
        JSON.stringify(JSON.parse(await readFile(resolve(buildRoot, 'owner.json'), 'utf8'))) !== JSON.stringify(owner)
    ) {
        throw new Error('Unowned production output.');
    }
}

export async function readProductionInputs(
    repoRoot: string,
    files: readonly FullStackRtcProductionInput[]
): Promise<void> {
    for (const file of files) {
        const path = resolve(repoRoot, file.path);
        await readConfinedProductionPath(repoRoot, path, 'file');
        if (createHash('sha256').update(await readFile(path)).digest('hex') !== file.sha256) {
            throw new Error('Production source inputs changed.');
        }
    }
}

export async function readConfinedProductionPath(
    root: string,
    path: string,
    kind: 'file' | 'directory'
): Promise<void> {
    const confined = relative(root, path);
    if (isAbsolute(confined) || confined.startsWith(`..${sep}`) || confined === '..') {
        throw new Error('Escaping production path.');
    }
    let current = root;
    for (const segment of confined.split(sep).filter(Boolean)) {
        current = resolve(current, segment);
        const status = await lstat(current);
        if (status.isSymbolicLink()) {
            throw new Error('Symlinked production path.');
        }
    }
    const status = await lstat(path);
    if (
        (kind === 'file' && !status.isFile()) || (kind === 'directory' && !status.isDirectory()) ||
        await realpath(path) !== resolve(await realpath(root), confined)
    ) {
        throw new Error('Unsafe production path.');
    }
}

export async function readProductionOutput(buildRoot: string): Promise<readonly FullStackRtcProductionFile[]> {
    const output = resolve(buildRoot, 'output');
    const files: FullStackRtcProductionFile[] = [];
    async function readDirectory(directory: string): Promise<void> {
        for (const name of (await readdir(directory)).sort()) {
            const path = resolve(directory, name);
            const status = await lstat(path);
            if (status.isSymbolicLink()) {
                throw new Error('Symlinked build output.');
            }
            if (status.isDirectory()) {
                await readDirectory(path);
            }
            else if (status.isFile()) {
                const bytes = await readFile(path);
                files.push({
                    path: relative(output, path).split(sep).join('/'),
                    sizeBytes: bytes.length,
                    sha256: createHash('sha256').update(bytes).digest('hex')
                });
            }
            else {
                throw new Error('Invalid build output.');
            }
        }
    }
    await readDirectory(output);
    return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function readProductionEntryFiles(
    buildRoot: string,
    files: readonly FullStackRtcProductionFile[]
): Promise<readonly string[]> {
    const entryFiles = decodeProductionManifestEntries(
        JSON.parse(await readFile(resolve(buildRoot, 'output/.vite/manifest.json'), 'utf8'))
    );
    if (!entryFiles.right) {
        throw new Error(entryFiles.left!);
    }
    const html = await readFile(resolve(buildRoot, 'output/index.html'), 'utf8');
    if (
        entryFiles.right.length === 0 ||
        entryFiles.right.some((path) => !files.some((file) => file.path === path) || !html.includes(path))
    ) {
        throw new Error('Incomplete production manifest.');
    }
    return [...entryFiles.right].sort();
}

function decodeProductionManifestEntries(raw: unknown): Either<string, readonly string[]> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return Either.ofLeft('Invalid production manifest.');
    }
    const entries = Object.values(raw).filter((value) => value && typeof value === 'object' && value.isEntry === true);
    const files = entries.map((value) => value.file);
    return files.every((path) => typeof path === 'string')
        ? Either.ofRight(files)
        : Either.ofLeft('Incomplete production manifest.');
}
