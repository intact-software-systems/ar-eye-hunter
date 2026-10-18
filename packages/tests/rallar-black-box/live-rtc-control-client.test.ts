import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import {
    createCapturedNativeConnectionFixture,
    createNativeRecorderRowsFixture,
    createRawRecipeNativeRecorderFixture,
    createRecipeNativeConnectionFixture
} from '../shared-test/rtc-native-acquisition-fixture.ts';
import { createDefaultLiveRtcControlHttpFixture, LiveRtcControlHttpFixture } from './live-rtc-control-http-fixture.ts';

describe('live RTC native archive HTTP adapter', () => {
    let fixture: LiveRtcControlHttpFixture;
    beforeEach(async () => {
        fixture = await createDefaultLiveRtcControlHttpFixture();
    });
    afterEach(async () => {
        await fixture.close();
    });

    it.each([17_156, 19_300])('admits a complete attributed root larger than %s bytes', async (size) => {
        const connection = createRecipeNativeConnectionFixture();
        const { root, actual, initialized } = createRawRecipeNativeRecorderFixture(connection);
        actual.padding = 'x'.repeat(size);
        fixture.state.recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
        const acquired = await fixture.control.readRtcNativeAcquisition(connection);
        expect(acquired.left).toBeUndefined();
        expect(acquired.right?.connection).toEqual(connection);
        expect(acquired.right?.source).toEqual({
            endpoint: fixture.baseUrl + '/runs/native-run/events.jsonl',
            durableOrigin: 'unknown',
            bytesRead: Buffer.byteLength(fixture.state.recorderJsonl),
            decodedRecords: 2,
            completeness: 'complete',
            malformedRows: 0,
            oversizedRows: 0
        });
        expect(fixture.state.recorderReads).toBe(1);
    });

    it('uses the exact encoded run endpoint and waits for trailing evidence', async () => {
        const connection = { ...createCapturedNativeConnectionFixture(), runId: 'native/run + one' };
        fixture.state.recorderJsonl = createNativeRecorderRowsFixture().map((row) => JSON.stringify(row)).join('\n') + '\n{broken';
        const acquired = await fixture.control.readRtcNativeAcquisition(connection);
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: 'acquisition-failed', source: { completeness: 'incomplete', malformedRows: 1 } });
        expect(fixture.state.recorderUrls).toEqual(['/runs/native%2Frun%20%2B%20one/events.jsonl']);
        await expect.poll(() => fixture.state.recorderClosed).toBe(true);
    });

    it('closes an open response on malformed input without retaining its payload', async () => {
        fixture.state.recorderOpenEnded = true;
        fixture.state.recorderJsonl = '{private-recorder-sentinel}\n';
        const acquired = await fixture.control.readRtcNativeAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.left?.reason).toBe('acquisition-failed');
        expect(JSON.stringify(acquired.left)).not.toContain('private-recorder-sentinel');
        await expect.poll(() => fixture.state.recorderClosed).toBe(true);
    });

    it('returns a finite recorder failure after one unavailable HTTP request', async () => {
        fixture.state.recorderStatus = 503;
        const acquired = await fixture.control.readRtcNativeAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: 'acquisition-failed', source: null, cause: expect.any(Error) });
        expect(fixture.state.recorderReads).toBe(1);
        await expect.poll(() => fixture.state.recorderClosed).toBe(true);
    });
});
