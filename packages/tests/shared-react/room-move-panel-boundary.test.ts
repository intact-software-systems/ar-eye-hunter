import { brotliCompressSync, constants } from 'node:zlib';

import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { collectExportSnapshot } from '../shared-web/public-api-snapshot-collector.ts';

const entry = 'packages/shared-react/room-move-panel.tsx';

describe('shared-react room move panel boundary', () => {
    it('exports the view and its props directly from their owner', () => {
        expect(collectExportSnapshot(entry, { resolveStarExports: false })).toEqual({
            values: ['RoomMovePanel'],
            types: ['RoomMovePanelProps'],
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
        expect(inputs).toContain('packages/shared/api/group-member-presence.ts');
        expect(inputs.filter((file) => file.startsWith('packages/shared-server/') || file.startsWith('packages/shared-web/'))).toEqual([]);
        // Preserve the existing panel budget when moving its package owner.
        const brotliKiB = brotliCompressSync(bundle.outputFiles[0].contents, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
        }).length / 1024;
        expect(brotliKiB).toBeLessThan(5);
    });
});
