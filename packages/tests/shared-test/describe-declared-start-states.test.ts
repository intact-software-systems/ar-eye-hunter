import { describe, expect, it } from 'vitest';

import type { RallarBlackBoxTestHttpRequestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toGrantRequests } from './describe-declared-start-states.ts';

function toGrantCommand(commandId: string, body: Readonly<Record<string, string | number | boolean>>): RallarBlackBoxTestHttpRequestCommand {
    return {
        kind: 'http.request',
        commandId,
        request: { path: `/groups/g/publication-grants/principal-a/grant/requests/${commandId}`, body }
    };
}

describe('toGrantRequests', () => {
    it('reads the topic and both permissions of a grant body', () => {
        const command = toGrantCommand('grant-a', { topicId: 'topic-a', publish: true, subscribe: false });

        expect(toGrantRequests([command])).toEqual([
            { operation: 'grant', principalId: 'principal-a', topicId: 'topic-a', permissions: { publish: true, subscribe: false } }
        ]);
    });

    it('refuses a grant body with a key other than the topic and the two permissions, naming its command', () => {
        const command = toGrantCommand('grant-extra', { topicId: 'topic-a', publish: true, subscribe: false, expiresAt: 1 });

        expect(() => toGrantRequests([command])).toThrow('grant-extra');
    });
});
