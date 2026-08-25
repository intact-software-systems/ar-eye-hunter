import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeSourceFile } from '../../helpers/source-analysis.ts';

describe('browser realtime ownership', () => {
    it('keeps health reads out of send and target policy', () => {
        const sender = analyzeSourceFile(path.resolve(
            'packages/shared-web/browser/realtime/browser-realtime-send-runtime.ts'
        ));

        expect(sender.identifierNames).not.toContain('health');
        expect(sender.identifierNames).not.toContain('RallarRealtimeHealthOptions');
        expect(sender.identifierNames).not.toContain('RallarRealtimeLaneHealth');
    });
});
