import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { hasLiveRtcNotYetInSyncNack, installLiveRtcWireObservation } from '../../../tests/playwright/rallar-black-box/live-rtc-wire-observation.ts';

describe('live RTC wire observation', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('captures incoming frames only during the probe, including newly received channels', () => {
        class NativePeerConnection extends EventTarget {
            createDataChannel(): EventTarget {
                return new EventTarget();
            }
        }
        vi.stubGlobal('window', { RTCPeerConnection: NativePeerConnection });
        installLiveRtcWireObservation();
        const peer = new window.RTCPeerConnection();
        const outgoing = peer.createDataChannel('application');
        const observation = window.__liveRtcWireObservation;
        if (!observation) {
            throw new Error('Wire observer was not installed.');
        }
        outgoing.dispatchEvent(new MessageEvent('message', { data: 'before-probe' }));
        expect(observation.read()).toEqual([]);

        observation.start();
        outgoing.dispatchEvent(new MessageEvent('message', { data: 'existing-channel-frame' }));
        const incoming = new EventTarget();
        peer.dispatchEvent(Object.assign(new Event('datachannel'), { channel: incoming }));
        incoming.dispatchEvent(new MessageEvent('message', { data: 'incoming-channel-frame' }));
        expect(observation.read()).toEqual(['existing-channel-frame', 'incoming-channel-frame']);
        observation.stop();
        incoming.dispatchEvent(new MessageEvent('message', { data: 'after-probe' }));
        expect(observation.read()).toEqual([]);

        incoming.dispatchEvent(new Event('close'));
        observation.start();
        incoming.dispatchEvent(new MessageEvent('message', { data: 'closed-channel-frame' }));
        expect(observation.read()).toEqual([]);
        observation.stop();
    });

    it('fails explicitly when the bounded capture overflows', () => {
        class NativePeerConnection extends EventTarget {
            createDataChannel(): EventTarget {
                return new EventTarget();
            }
        }
        vi.stubGlobal('window', { RTCPeerConnection: NativePeerConnection });
        installLiveRtcWireObservation();
        const channel = new window.RTCPeerConnection().createDataChannel('application');
        window.__liveRtcWireObservation?.start();
        for (let i = 0; i < 1_001; i++) {
            channel.dispatchEvent(new MessageEvent('message', { data: 'frame' }));
        }
        expect(() => window.__liveRtcWireObservation?.read()).toThrow('frame limit');
        window.__liveRtcWireObservation?.stop();
    });
});

describe('received not-yet-in-sync NACK proof', () => {
    const probe = { messageId: 'sent-message', senderSessionId: 'session-a', targetSessionId: 'session-b' };
    const nack = { msgId: 'sent-message', reason: 'not-yet-in-sync', fromPeerId: 'session-b', toPeerId: 'session-a' };
    const frame = JSON.stringify({ payload: { typeId: 'al.control.nack.v1', resource: JSON.stringify(nack) } });

    it('accepts only the received protocol NACK matching message and both sessions', () => {
        expect(hasLiveRtcNotYetInSyncNack({ ...probe, frames: [frame] })).toBe(true);
    });

    it.each([
        { ...probe, messageId: 'another-message' },
        { ...probe, senderSessionId: 'another-sender' },
        { ...probe, targetSessionId: 'another-target' }
    ])('rejects unrelated identity %#', (identity) => {
        expect(hasLiveRtcNotYetInSyncNack({ ...identity, frames: [frame] })).toBe(false);
    });

    it.each([
        'not JSON',
        JSON.stringify({ commandId: 'nack-not-yet-in-sync-command', ok: false, error: { message: 'unrelated failure' } }),
        JSON.stringify({ minSnapshotVersion: 9_999_999, message: { id: { msgId: 'sent-message' } } }),
        JSON.stringify({ payload: { typeId: 'manual.type', resource: JSON.stringify(nack) } }),
        JSON.stringify({ payload: { typeId: 'al.control.nack.v1', resource: 'invalid resource' } }),
        JSON.stringify({ payload: { typeId: 'al.control.nack.v1', resource: JSON.stringify({ ...nack, reason: 'unauthorized' }) } })
    ])('rejects malformed, echoed, or different protocol evidence %#', (unrelated) => {
        expect(hasLiveRtcNotYetInSyncNack({ ...probe, frames: [unrelated] })).toBe(false);
    });
});
