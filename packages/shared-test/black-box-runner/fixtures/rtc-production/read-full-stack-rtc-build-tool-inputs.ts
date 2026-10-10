import { readFile, realpath } from 'node:fs/promises';
import { createRequire, findPackageJSON } from 'node:module';
import {
    dirname,
    relative,
    resolve,
    sep
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type FullStackRtcBuildToolResult<T> = { readonly ok: true; readonly value: T; } | {
    readonly ok: false;
    readonly issues: readonly { readonly code: 'unbound-build-tool-owner'; readonly message: string; }[];
};

export interface FullStackRtcBuildToolSelection {
    readonly repoRoot: string;
    readonly compilerEntry: string;
    readonly compilerResolver: string;
    readonly compilerNative: string;
    readonly compilerNativePackage: string;
    readonly viteEntry: string;
    readonly viteExecutable: string;
    readonly bundlerEntry: string;
    readonly bundlerImports: readonly string[];
    readonly nativeBindings: readonly string[];
    readonly nativePackage: string;
}

export async function readFullStackRtcBuildToolInputs(): Promise<FullStackRtcBuildToolResult<readonly string[]>> {
    try {
        process.env.NODE_ENV = 'production';
        const repoRoot = await realpath(process.cwd());
        const app = pathToFileURL(resolve(repoRoot, 'apps/rallar-black-box/package.json')).href;
        const compilerPackage = fileURLToPath(import.meta.resolve('typescript/package.json', app));
        const compilerResolver = resolve(dirname(compilerPackage), 'lib/getExePath.js');
        const compiler = await import(pathToFileURL(compilerResolver).href);
        const compilerNative = decodeCompilerNativePath(compiler.default());
        if (compilerNative === null) {
            return buildToolFailure();
        }
        const viteEntry = fileURLToPath(import.meta.resolve('vite', app));
        const bundlerEntry = fileURLToPath(import.meta.resolve('rolldown', pathToFileURL(viteEntry).href));
        const require = createRequire(pathToFileURL(bundlerEntry));
        const before = new Set(Object.keys(require.cache));
        await import(pathToFileURL(bundlerEntry).href);
        const nativeBindings = Object.keys(require.cache).filter((path) => path.endsWith('.node') && !before.has(path));
        const nativePackage = nativeBindings.length === 1
            ? findPackageJSON(pathToFileURL(nativeBindings[0]!).href)
            : undefined;
        const compilerNativePackage = findPackageJSON(pathToFileURL(compilerNative).href);
        if (!nativePackage || !compilerNativePackage) {
            return buildToolFailure();
        }
        const selection = {
            repoRoot,
            compilerEntry: await readNpmBuildExecutable(repoRoot, 'tsc'),
            compilerResolver,
            compilerNative,
            compilerNativePackage,
            viteEntry,
            viteExecutable: await readNpmBuildExecutable(repoRoot, 'vite'),
            bundlerEntry,
            nativeBindings,
            nativePackage,
            bundlerImports: await readBundlerEntryImports(bundlerEntry)
        };
        return toFullStackRtcBuildToolInputs(selection);
    }
    catch {
        return buildToolFailure();
    }
}

export function toFullStackRtcBuildToolInputs(
    selection: FullStackRtcBuildToolSelection
): FullStackRtcBuildToolResult<readonly string[]> {
    const paths = [
        selection.compilerEntry,
        selection.compilerResolver,
        selection.compilerNative,
        selection.compilerNativePackage,
        selection.viteEntry,
        selection.viteExecutable,
        selection.bundlerEntry,
        ...selection.bundlerImports,
        ...selection.nativeBindings,
        selection.nativePackage
    ];
    const confined = paths.map((path) => relative(selection.repoRoot, path).split(sep).join('/'));
    if (
        selection.nativeBindings.length !== 1 ||
        confined.some((path) =>
            !/^[a-zA-Z0-9@._/-]+$/.test(path) || path.split('/').includes('..') || path.startsWith('/')
        )
    ) {
        return buildToolFailure();
    }
    const installedOwner = (path: string, owner: string) =>
        relative(selection.repoRoot, path).split(sep).join('/').startsWith(`node_modules/${owner}`);
    if (
        !installedOwner(selection.compilerEntry, 'typescript/') ||
        !installedOwner(selection.compilerResolver, 'typescript/') ||
        !installedOwner(selection.compilerNative, '@typescript/typescript-') ||
        !installedOwner(selection.compilerNativePackage, '@typescript/typescript-') ||
        !installedOwner(selection.viteEntry, 'vite/') || !installedOwner(selection.viteExecutable, 'vite/') ||
        !selection.compilerEntry.startsWith(`${dirname(dirname(selection.compilerResolver))}${sep}`) ||
        !selection.viteExecutable.startsWith(`${resolve(dirname(selection.viteEntry), '../../..')}${sep}`) ||
        !installedOwner(selection.bundlerEntry, 'rolldown/') ||
        selection.bundlerImports.some((path) => !path.startsWith(`${dirname(selection.bundlerEntry)}${sep}`)) ||
        !installedOwner(selection.nativeBindings[0]!, '@rolldown/binding-') ||
        !installedOwner(selection.nativePackage, '@rolldown/binding-') ||
        !selection.compilerNative.startsWith(`${dirname(selection.compilerNativePackage)}${sep}`) ||
        !selection.nativeBindings[0]!.startsWith(`${dirname(selection.nativePackage)}${sep}`)
    ) {
        return buildToolFailure();
    }
    return { ok: true, value: [...new Set(confined)].sort() };
}

async function readNpmBuildExecutable(repoRoot: string, name: string): Promise<string> {
    try {
        return await realpath(resolve(repoRoot, 'apps/rallar-black-box/node_modules/.bin', name));
    }
    catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
            throw error;
        }
        return realpath(resolve(repoRoot, 'node_modules/.bin', name));
    }
}

async function readBundlerEntryImports(entry: string): Promise<readonly string[]> {
    const source = await readFile(entry, 'utf8');
    return [...source.matchAll(/from\s+["'](\.\/[^"']+\.mjs)["']/g)].map((match) => resolve(dirname(entry), match[1]!));
}

function decodeCompilerNativePath(raw: unknown): string | null {
    return typeof raw === 'string' ? raw : null;
}

function buildToolFailure(): FullStackRtcBuildToolResult<never> {
    return {
        ok: false,
        issues: [{
            code: 'unbound-build-tool-owner',
            message: 'Selected installed build-tool owners could not be bound.'
        }]
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await readFullStackRtcBuildToolInputs();
    if (result.ok) {
        process.stdout.write(JSON.stringify(result.value));
    }
    else {
        process.stderr.write('Selected installed build-tool owners could not be bound.\n');
        process.exitCode = 1;
    }
}
