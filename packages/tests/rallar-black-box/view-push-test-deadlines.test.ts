import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { decodeDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run-validation.ts';

import { computeViewPushTestDeadlines } from '../../../tests/playwright/rallar-black-box/compute-view-push-test-deadlines.ts';

const repoRoot = path.resolve(__dirname, '../../..');

describe('view push test deadlines', () => {
    // The spec waited 90 s for manifest 24 to reach a terminal state while the manifest recommends 175 s.
    it('waits for the view push run its manifest\'s recommended terminal timeout and covers both waits', () => {
        const manifest = decodeDistributedRunManifest(JSON.parse(readFileSync(
            path.join(repoRoot, 'apps/rallar-black-box/manifests/hetzner/24-view-push-2-agent.json'),
            'utf8'
        ))).fold(() => {
            throw new Error('Manifest 24 could not be decoded.');
        }, (value) => value);

        expect(computeViewPushTestDeadlines(manifest)).toEqual({
            readinessTimeoutMs: 90_000,
            terminalTimeoutMs: 175_000,
            testTimeoutMs: 180_000 + 90_000 + 175_000
        });
    });
});
