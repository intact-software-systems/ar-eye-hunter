import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HARNESS_ENTRY = 'tests/playwright/alm/harness/durable-send-harness-page.ts';
/** esbuild opens every module of an unminified bundle with a `// <path>` line naming its source. */
const MODULE_MARKER = /^\/\/ (\S+\.[cm]?[jt]sx?)$/;

/** Where one bundled module's code starts, so a profile's bundle line can be traced to its source file. */
export interface BundledModule {
    readonly startLine: number;
    readonly source: string;
}

export interface DurableSendHarnessBundle {
    readonly script: string;
    readonly modules: readonly BundledModule[];
}

/**
 * The harness page as one unminified ES module with its function names kept, so a CPU profile names
 * the functions and every bundle line maps to the module it came from.
 */
export async function bundleDurableSendHarness(): Promise<DurableSendHarnessBundle> {
    const result = await build({
        absWorkingDir: REPOSITORY_ROOT,
        entryPoints: [HARNESS_ENTRY],
        tsconfig: join(REPOSITORY_ROOT, 'tsconfig.json'),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        minify: false,
        keepNames: true,
        write: false,
        logLevel: 'silent'
    });
    const script = result.outputFiles[0]!.text;
    return { script, modules: toBundledModules(script) };
}

function toBundledModules(script: string): readonly BundledModule[] {
    const modules: BundledModule[] = [];
    script.split('\n').forEach((line, index) => {
        const source = MODULE_MARKER.exec(line)?.[1];
        if (source !== undefined) {
            modules.push({ startLine: index, source });
        }
    });
    return modules;
}
