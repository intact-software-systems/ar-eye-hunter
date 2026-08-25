import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeSourceFile } from '../../helpers/source-analysis.ts';

describe('browser message ownership', () => {
    it('keeps transport send and typed channel policy out of the lifecycle controller', () => {
        const controller = analyzeSourceFile(path.resolve(
            'packages/shared-web/browser/messages/browser-rallar-messages-controller.ts'
        ));
        expect(controller.identifierNames).not.toContain('newALBroadcastMessage');
        expect(controller.identifierNames).not.toContain('newALMulticastMessage');
        expect(controller.identifierNames).not.toContain('enqueueOutboxIfAbsent');
        expect(controller.identifierNames).not.toContain('sendTypedMessageWithStrategy');
    });
});
