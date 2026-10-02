import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import { BrowserALSessionChannel } from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALDurableWorkCommit } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { ALWorkCommittedRows } from '@shared/alm/work/al-work-readiness-memory.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { FakeBroadcastChannel } from '../data/rallar-data-test-runtime.ts';

const SCOPE: StateScope = { applicationId: 'app:one', workspaceId: 'work space' };
const ROWS: ALWorkCommittedRows = { dueByMs: 10, writtenKeys: ['row-a'] };
const COMMIT: ALDurableWorkCommit = { workType: 'AL_OUTBOUND:a', rows: ROWS };
const SETTLEMENT: ALDeliverySettlement = {
    kind: 'attempt-started',
    msgId: 'message-1',
    carrier: 'ws',
    atMs: 1,
    attemptId: 'attempt-1'
};

/** Like the browser's `BroadcastChannel`, a closed port throws on post. */
class ClosableBroadcastChannel extends FakeBroadcastChannel {
    private closed = false;

    public override postMessage(message: object): void {
        if (this.closed) {
            throw new DOMException('BroadcastChannel is closed.', 'InvalidStateError');
        }
        super.postMessage(message);
    }

    public override close(): void {
        this.closed = true;
        super.close();
    }
}

afterEach(() => {
    FakeBroadcastChannel.clear();
});

describe('browser AL session channel', () => {
    it('names one channel per scope and session, each part of the scope encoded', () => {
        const opened: string[] = [];

        createTab({
            sessionId: 'session-1',
            openPort: (name) => {
                opened.push(name);
                return new FakeBroadcastChannel(name);
            }
        });

        expect(opened).toEqual(['rallar-alm:app%3Aone:work%20space:session-1']);
    });

    it('hands another tab\'s commit, with its work type and rows, to its listeners', async () => {
        const owner = createTab({ sessionId: 'session-1' });
        const writer = createTab({ sessionId: 'session-1' });
        const heard: ALDurableWorkCommit[] = [];
        owner.channel.onCommitted((commit) => heard.push(commit));

        writer.channel.announceCommit(COMMIT);
        await flushChannel();

        expect(heard).toEqual([COMMIT]);
    });

    it('stops handing commits to a listener that unsubscribed, and to a closed channel', async () => {
        const owner = createTab({ sessionId: 'session-1' });
        const writer = createTab({ sessionId: 'session-1' });
        const heard: string[] = [];
        const unsubscribe = owner.channel.onCommitted(() => heard.push('unsubscribed'));
        const other = createTab({ sessionId: 'session-1' });
        other.channel.onCommitted(() => heard.push('closed'));

        unsubscribe();
        other.channel.close();
        writer.channel.announceCommit(COMMIT);
        await flushChannel();

        expect(heard).toEqual([]);
    });

    it('applies a relayed settlement through its own observers', async () => {
        const holder = createTab({ sessionId: 'session-1' });
        const relaying = createTab({ sessionId: 'session-1' });

        relaying.channel.relaySettlement(SETTLEMENT);
        await flushChannel();

        expect(holder.applied).toEqual([SETTLEMENT]);
        expect(relaying.applied).toEqual([]);
    });

    it('never crosses sessions or scopes', async () => {
        const otherSession = createTab({ sessionId: 'session-2' });
        const otherScope = createTab({ sessionId: 'session-1', scope: { ...SCOPE, workspaceId: 'other' } });
        const heard: string[] = [];
        otherSession.channel.onCommitted(() => heard.push('other-session'));
        otherScope.channel.onCommitted(() => heard.push('other-scope'));
        const writer = createTab({ sessionId: 'session-1' });

        writer.channel.announceCommit(COMMIT);
        writer.channel.relaySettlement(SETTLEMENT);
        await flushChannel();

        expect(heard).toEqual([]);
        expect(otherSession.applied).toEqual([]);
        expect(otherScope.applied).toEqual([]);
    });

    // A second channel object of the same tab instance echoes what the first posted; the tab must not
    // apply its own relay or wake itself.
    it('ignores a message carrying its own instance id, another session key, or another version', async () => {
        const tab = createTab({ sessionId: 'session-1', instanceId: 'tab-a' });
        const heard: ALDurableWorkCommit[] = [];
        tab.channel.onCommitted((commit) => heard.push(commit));
        const raw = new FakeBroadcastChannel('rallar-alm:app%3Aone:work%20space:session-1');
        const envelope = { version: 1, sessionKey: 'app%3Aone:work%20space:session-1', instanceId: 'tab-b' };
        const bodies = [
            { kind: 'settlement', settlement: SETTLEMENT },
            { kind: 'committed', workType: 'AL_OUTBOUND:a', rows: ROWS }
        ];

        for (const body of bodies) {
            raw.postMessage({ ...envelope, instanceId: 'tab-a', ...body });
            raw.postMessage({ ...envelope, sessionKey: 'app%3Aone:work%20space:session-2', ...body });
            raw.postMessage({ ...envelope, version: 2, ...body });
            raw.postMessage({ ...envelope, ...body });
        }
        await flushChannel();

        expect(tab.applied).toEqual([SETTLEMENT]);
        expect(heard).toEqual([COMMIT]);
    });

    it('ignores a post after close: it neither throws nor reaches another tab', async () => {
        const holder = createTab({ sessionId: 'session-1' });
        const heard: ALDurableWorkCommit[] = [];
        holder.channel.onCommitted((commit) => heard.push(commit));
        const closed = createTab({ sessionId: 'session-1', openPort: (name) => new ClosableBroadcastChannel(name) });
        closed.channel.close();

        expect(() => {
            closed.channel.announceCommit(COMMIT);
            closed.channel.relaySettlement(SETTLEMENT);
        }).not.toThrow();
        await flushChannel();

        expect(heard).toEqual([]);
        expect(holder.applied).toEqual([]);
    });

    it('posts nothing and wakes nothing where the browser has no channel', () => {
        const tab = createTab({ sessionId: 'session-1', openPort: () => undefined });
        const heard: ALDurableWorkCommit[] = [];

        const unsubscribe = tab.channel.onCommitted((commit) => heard.push(commit));
        tab.channel.announceCommit(COMMIT);
        tab.channel.relaySettlement(SETTLEMENT);
        unsubscribe();
        tab.channel.close();

        expect(heard).toEqual([]);
        expect(tab.applied).toEqual([]);
    });
});

interface SessionTab {
    readonly channel: BrowserALSessionChannel;
    /** Every settlement another tab relayed to this one, in arrival order. */
    readonly applied: readonly ALDeliverySettlement[];
}

interface SessionTabInput {
    readonly sessionId: string;
    readonly scope?: StateScope;
    readonly instanceId?: string;
    readonly openPort?: BrowserALSessionChannel.OpenPort;
}

function createTab(input: SessionTabInput): SessionTab {
    const applied: ALDeliverySettlement[] = [];
    const channel = new BrowserALSessionChannel({
        scope: input.scope ?? SCOPE,
        sessionId: input.sessionId,
        instanceId: input.instanceId ?? crypto.randomUUID(),
        openPort: input.openPort ?? ((name) => new FakeBroadcastChannel(name)),
        applySettlement: (settlement) => applied.push(settlement)
    });
    return { channel, applied };
}

/** The fake delivers on a microtask per receiver; one macrotask drains every delivery a post queued. */
async function flushChannel(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}
