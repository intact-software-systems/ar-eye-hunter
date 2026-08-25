import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeSourceFile } from '../../helpers/source-analysis.ts';

describe('browser RTC ownership', () => {
    it('keeps room view and recovery policy out of the facade controller', () => {
        const controller = analyzeSourceFile(path.resolve(
            'packages/shared-web/browser/rtc/browser-rallar-rtc-controller.ts'
        ));

        expect(controller.identifierNames).not.toContain('restartRtcIce');
        expect(controller.identifierNames).not.toContain('reconnectRtcPeer');
        expect(controller.identifierNames).not.toContain('toRoomTransportStatus');
        expect(controller.identifierNames).not.toContain('resolveRtcRoomTransportState');
    });
});
