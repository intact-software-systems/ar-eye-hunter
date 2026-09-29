import {
    buildSync,
    type Metafile
} from 'esbuild';
import {
    mkdirSync,
    readFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    brotliCompressSync,
    constants
} from 'node:zlib';
import {
    describe,
    expect,
    it
} from 'vitest';

interface HeadlessBundleMeasurement {
    readonly brotliKiB: number;
    readonly metafile: Metafile;
}

describe('rallar-black-box-headless bundle boundary', () => {
    it('excludes operator UI dependencies and surfaces', () => {
        const result = bundleHeadlessEntry(
            process.cwd(),
            path.join(tmpdir(), 'rallar-black-box-headless-boundary-test')
        );
        const inputs = Object.keys(result.metafile.inputs);

        for (
            const forbidden of [
                'node_modules/react',
                'node_modules/react-dom',
                'node_modules/sigma',
                'node_modules/graphology',
                'apps/rallar-black-box/src/app.tsx',
                'apps/rallar-black-box/src/control-run-manager/',
                'apps/rallar-black-box/src/distributed-recipes.ts',
                'apps/rallar-black-box/src/rtc-diagnostics.ts',
                'apps/rallar-black-box/src/topology-graph.ts',
                'apps/rallar-black-box/src/flow-builder',
                'apps/rallar-black-box/src/schema-authoring.ts',
                'packages/shared-test/rallar-bb-test/schema.ts',
                'packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-capabilities.ts',
                'packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts'
            ]
        ) {
            expect(inputs, `headless bundle should not include ${forbidden}`).not.toContainEqual(
                expect.stringContaining(forbidden)
            );
        }

        const budgetKiB = readBrotliBudgetKiB();
        expect(
            result.brotliKiB,
            `the headless agent measures ${result.brotliKiB.toFixed(3)} KiB against ${budgetKiB} in headless-bundle-budget.json; ` +
                `the budget is adjustable, so raise it to ${Math.floor(result.brotliKiB) + 1} and say so in the PR`
        ).toBeLessThan(budgetKiB);
    });
});

function readBrotliBudgetKiB(): number {
    return decodeBrotliBudget(
        readFileSync(path.join(process.cwd(), 'packages/tests/rallar-black-box-headless/headless-bundle-budget.json'), 'utf8')
    );
}

function decodeBrotliBudget(text: string): number {
    return JSON.parse(text).brotliBudgetKiB;
}

function bundleHeadlessEntry(repoRoot: string, outputDir: string): HeadlessBundleMeasurement {
    mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'headless-agent.boundary.min.js');
    const result = buildSync({
        absWorkingDir: repoRoot,
        entryPoints: ['apps/rallar-black-box-headless/src/main.ts'],
        bundle: true,
        minify: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2023',
        tsconfig: 'apps/rallar-black-box-headless/tsconfig.json',
        outfile: outputPath,
        metafile: true
    });

    const bytes = readFileSync(outputPath);
    const brotliBytes = brotliCompressSync(bytes, {
        params: {
            [constants.BROTLI_PARAM_QUALITY]: 11
        }
    }).length;

    return {
        brotliKiB: brotliBytes / 1024,
        metafile: result.metafile
    };
}
