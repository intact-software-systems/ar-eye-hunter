import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';

/** The terminal wait a spec gives a run: what its manifest recommends. */
export function toRecommendedTerminalTimeoutMs(manifest: RallarBlackBoxDistributedRunManifest): number {
    const seconds = manifest.metadata.recommendedTerminalTimeoutSeconds;
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds <= 0) {
        throw new Error(`Manifest ${manifest.distributedRunId} names no recommended terminal timeout.`);
    }
    return seconds * 1_000;
}
