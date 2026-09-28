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

        // The control-command validator reads its field tables from the canonical command-field
        // definition, so neither the JSON schema nor the capability catalog ships to the agent.
        // The v2 acknowledgement, the receipt control, one relayed ACK per logical recipient, and
        // the send-time QoS request check with the messages.send qos passthrough measure
        // 275.1064453125 KiB with this exact harness; the WS client's receipt admission from the
        // server's aggregate brings it to 276.16796875 KiB, and the rest of S2c-i to 276.7197265625 KiB.
        // S2c-ii's frozen audience at RTC admission (the freeze, its ingress check and provenance) measures
        // 277.2451171875 KiB, and its retry through the relay tree (the missing-recipient repair, the
        // per-recipient relay row and the retried-copy path) 278.1376953125 KiB. Its logical evidence (the
        // recipient lists, the hop view, the trusted relay rejection and the observation decoders) measures
        // 279.2412109375 KiB. Its closing harness checks (a raw control that resolves its own msgId from an earlier
        // result, and the observation decoder refusing a server relay id) measure 280.05078125 KiB. The recipe
        // barrier (D62: the barrier protocol, its waiter and validator, and the control client's resolution frame)
        // measures 281.2978515625 KiB and its deadline-versus-timeout failure labels 281.619140625 KiB. S3a's
        // purpose and receipt defaults measured 281.0185546875 KiB on the CI runner at 0c3302606 (the runner
        // measures about 0.1 KiB above this machine), its tracked receipt at admission (R-S3a-4) 281.1708984375 KiB
        // here, and its store lanes (a memory pair beside the IndexedDB pair on each outbound carrier, routed by
        // durability) 282.255859375 KiB here; the S3a tree with the barrier merged in measures 283.7880859375 KiB here.
        // The ceiling was 284 (the final S3a review head e417fe749 measured 283.62 of 284). S3b's receipt ends
        // (receipt-exhausted, the not-yet-in-sync exhaustion, completion at dispatch and the untracked receipt)
        // measure 284.0087890625 KiB here. The next whole-KiB ceiling is 285. The S3b final review head measures
        // 284.79 of 285, and its fix wave 284.82421875 here. S3c-i's room-naming unicast and the unicast receipt
        // measure 285.017578125 KiB here. The next whole-KiB ceiling is 286. All operator dependency exclusions
        // above remain enforced.
        expect(result.brotliKiB).toBeLessThan(286);
    });
});

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
