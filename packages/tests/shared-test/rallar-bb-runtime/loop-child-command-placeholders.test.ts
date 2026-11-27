import { describe, expect, it } from 'vitest';

import { toLoopChildCommand } from '@shared-test/rallar-bb-test/loop/to-loop-child-command.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

describe('rallar-bb loop child command placeholders', () => {
    it('resolves a placeholder inside a list and a nested record, and keeps every member that holds none', () => {
        const template: RallarBlackBoxTestCommand = {
            kind: 'rtc.send',
            commandId: 'frame',
            timeoutMs: undefined,
            send: {
                frames: ['{loop.index}', 'frame-{loop.index}', ['{loop.iteration}'], { seq: '{loop.commandIndex}' }],
                kept: [null, true, 7, 'plain'],
                none: null,
                absent: undefined
            }
        };

        const child = toLoopChildCommand({
            template,
            context: { loopCommandId: 'paced', index: 4, iteration: 5, elapsedMs: 120, atEpochMs: 1_800, commandIndex: 1 }
        });

        expect(child).toEqual({
            kind: 'rtc.send',
            commandId: 'paced:i5:c2:frame',
            send: {
                frames: [4, 'frame-4', [5], { seq: 1 }],
                kept: [null, true, 7, 'plain'],
                none: null
            },
            metadata: {
                loop: {
                    commandId: 'paced',
                    index: 4,
                    iteration: 5,
                    elapsedMs: 120,
                    commandIndex: 1,
                    originalCommandId: 'frame'
                }
            }
        });
    });
});
