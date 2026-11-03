import { brotliCompressSync, constants } from 'node:zlib';

import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { collectExportSnapshot } from '../shared-web/public-api-snapshot-collector.ts';

const panels = [
    {
        entry: 'packages/shared-react/room-move-panel.tsx',
        symbol: 'RoomMovePanel',
        requiredInputs: ['packages/shared/api/group-member-presence.ts'],
        allowedWebInputs: [],
        maxBrotliKiB: 5
    },
    {
        entry: 'packages/shared-react/room-moderation-panel.tsx',
        symbol: 'RoomModerationPanel',
        requiredInputs: ['packages/shared/api/group-member-presence.ts'],
        allowedWebInputs: ['packages/shared-web/browser/rooms/room-membership-revocation.ts', 'packages/shared-web/browser/api/http-error.ts'],
        maxBrotliKiB: 7
    },
    { entry: 'packages/shared-react/party-panel.tsx', symbol: 'PartyPanel', requiredInputs: [], allowedWebInputs: [], maxBrotliKiB: 5 }
];

describe.each(panels)('shared-react $symbol boundary', ({ entry, symbol, requiredInputs, allowedWebInputs, maxBrotliKiB }) => {
    it('exports the view and its props directly from their owner', () => {
        expect(collectExportSnapshot(entry, { resolveStarExports: false })).toEqual({
            values: [symbol],
            types: [`${symbol}Props`],
            starExports: [],
            namespaceExports: []
        });
    });

    it('bundles the view with React without pulling in the runtime owner or server', () => {
        const bundle = buildSync({
            entryPoints: [entry],
            bundle: true,
            minify: true,
            platform: 'browser',
            format: 'esm',
            target: 'es2022',
            tsconfig: 'packages/shared-react/tsconfig.json',
            write: false,
            metafile: true
        });
        const inputs = Object.keys(bundle.metafile.inputs);
        expect(inputs).toContainEqual(expect.stringContaining('node_modules/react/'));
        for (const input of requiredInputs) {
            expect(inputs).toContain(input);
        }
        expect(inputs.filter((file) => file.startsWith('packages/shared-server/'))).toEqual([]);
        expect(inputs.filter((file) => file.startsWith('packages/shared-web/')).sort()).toEqual(allowedWebInputs.toSorted());
        // Moderation includes access monitoring and HTTP policy decoding; other views retain their 5 KiB budget.
        const brotliKiB = brotliCompressSync(bundle.outputFiles[0].contents, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
        }).length / 1024;
        expect(brotliKiB).toBeLessThan(maxBrotliKiB);
    });
});
