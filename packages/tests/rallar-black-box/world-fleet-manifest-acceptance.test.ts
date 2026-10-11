import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
    describe,
    expect,
    it
} from 'vitest';

import { expectWorldFleetManifest } from '../../../tests/playwright/rallar-black-box/expect-world-fleet-manifest.ts';
import { decodeDistributedRunManifest } from '../../shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../shared-test/rallar-bb-test/distributed-run.ts';

interface ManifestMutation {
    readonly label: string;
    readonly change: Partial<RallarBlackBoxDistributedRunManifest>;
}

const source = await readFile('apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json');
const authored = decodeDistributedRunManifest(JSON.parse(source.toString('utf8'))).fold(
    () => {
        throw new Error('Frozen workload must decode.');
    },
    (manifest) => manifest
);

describe('world-fleet native manifest acceptance', () => {
    it('keeps the independent authored-byte workload identity', () => {
        expect(source.byteLength).toBe(243280);
        expect(createHash('sha256').update(source).digest('hex')).toBe('43db26dfab5a32b28f12b9d34db3be32b071a08139eee57f450807109072ecd3');
        expect(authored.rtcCaptureMode).toBeUndefined();
        expect(authored.targetPolicy.expectedParticipantCount).toBe(15);
        expect(authored.groupAssertions).toHaveLength(73);
    });

    it.each(
        [
            { input: undefined, effective: undefined },
            { input: '', effective: undefined },
            { input: ' \t ', effective: undefined },
            { input: 'off', effective: 'off' },
            { input: 'signaling', effective: 'signaling' },
            { input: 'native', effective: 'native' }
        ] as const
    )('accepts the exact effective manifest for $input', ({ input, effective }) => {
        const actual = effective === undefined ? structuredClone(authored) : { ...authored, rtcCaptureMode: effective };
        expect(() => expectWorldFleetManifest(actual, authored, input)).not.toThrow();
    });

    it.each(['bogus', 'OFF', ' native '])('rejects invalid selection %s before accepting even an authored snapshot', (input) => {
        expect(() => expectWorldFleetManifest(authored, authored, input)).toThrow('RTC capture mode');
    });

    it('preserves authored capture when blank and rejects a different effective selection', () => {
        const selected = { ...authored, rtcCaptureMode: 'native' as const };
        expect(() => expectWorldFleetManifest(selected, selected, '')).not.toThrow();
        expect(() => expectWorldFleetManifest({ ...selected, rtcCaptureMode: 'off' }, selected, '')).toThrow();
        expect(() => expectWorldFleetManifest(selected, authored, 'off')).toThrow();
        expect(() => expectWorldFleetManifest(authored, authored, 'native')).toThrow();
    });

    it.each(
        [
            { label: 'workload', change: { recipes: [] } },
            { label: 'participants', change: { targetPolicy: { ...authored.targetPolicy, expectedParticipantCount: 14 } } },
            { label: 'assertions', change: { groupAssertions: [] } },
            { label: 'deadline', change: { ackTimeoutMs: 60_000 } },
            { label: 'identity', change: { distributedRunId: 'substituted-run' } }
        ] satisfies readonly ManifestMutation[]
    )(
        'rejects unrelated $label changes even with an authorized capture mode',
        ({ change }) => {
            expect(() => expectWorldFleetManifest({ ...authored, rtcCaptureMode: 'native', ...change }, authored, 'native')).toThrow();
        }
    );
});
