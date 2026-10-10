import { deepStrictEqual } from 'node:assert';

import { applyWorldFleetCaptureMode } from '../../../apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { parseRtcCaptureMode } from '../../../packages/shared/webrtc/rtc-capture-configuration.ts';

/** Compare admitted execution intent without weakening the authored workload contract. */
export function expectWorldFleetManifest(
    actual: RallarBlackBoxDistributedRunManifest,
    authored: RallarBlackBoxDistributedRunManifest,
    captureInput: string | undefined
): void {
    const capture = parseRtcCaptureMode(captureInput?.trim() === '' ? undefined : captureInput).fold(
        (issues) => {
            throw new Error(issues.map((issue) => issue.message).join('\n'));
        },
        (selection) => selection
    );
    deepStrictEqual(actual, applyWorldFleetCaptureMode(authored, capture));
}
