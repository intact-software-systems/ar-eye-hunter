import { beforeEach, expect, it } from 'vitest';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { createRoomSnapshot, resetRoomWorkflowTestRuntime, seedRoomSnapshots } from './room-workflow-test-runtime.ts';

installFakeBroadcastChannelPerTest();
beforeEach(resetRoomWorkflowTestRuntime);

it('constructs a room-bound live channel with its required pacing policy', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const snapshot = createRoomSnapshot('live-market', ['session-1']);
    seedRoomSnapshots([snapshot]);
    const session = createRallarFacade().rooms.session(snapshot.group);
    expect(() =>
        session.message({
            topicId: 'room.market-input',
            typeId: 'input',
            purpose: 'live',
            access: 'members',
            publication: { cadenceMs: 50, retainNewest: 1, drain: { messages: 1, bytes: 2048 } }
        })
    ).not.toThrow();
    expect(() =>
        session.message({
            topicId: 'room.market-input',
            typeId: 'input',
            purpose: 'live',
            access: 'members',
            publication: { cadenceMs: -1, retainNewest: 1, drain: { messages: 1, bytes: 2048 } }
        })
    ).toThrow();
});
