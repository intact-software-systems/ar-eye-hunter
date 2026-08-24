import { AppInboxQueueClient, AppInboxType, classifyAppInboxError } from '@shared-server/mod.ts';
import { describe, expect, it } from 'vitest';

describe('shared-server AppInbox public surface', () => {
    it('exposes the current queue client, operations, and typed error classification', () => {
        expect(typeof AppInboxQueueClient).toBe('function');
        expect(AppInboxType.GROUP_CREATE).toBe('GROUP_CREATE');
        expect(classifyAppInboxError(new TypeError('malformed command'))).toMatchObject({
            kind: 'terminal',
            result: {
                code: 'app-inbox-malformed-command',
                status: 400
            }
        });
    });
});
