import { expect, type APIRequestContext } from '@playwright/test';

import type { ControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { FULL_STACK_CONTROL_BASE_URL } from './full-stack-helpers.ts';

export async function createDistributedRun(
    request: APIRequestContext,
    manifest: RallarBlackBoxDistributedRunManifest
): Promise<ControlDistributedRunSnapshot> {
    const response = await request.post(`${FULL_STACK_CONTROL_BASE_URL}/distributed-runs`, {
        data: { manifest }
    });
    expect(response.status()).toBe(201);
    return decodeControlDistributedRunSnapshot(await response.json()).fold(throwBoundaryError, (value) => value);
}

export async function mutateDistributedRun(
    request: APIRequestContext,
    distributedRunId: string,
    action: 'stage' | 'start' | 'cancel'
): Promise<ControlDistributedRunSnapshot> {
    const response = await request.post(
        `${FULL_STACK_CONTROL_BASE_URL}/distributed-runs/${encodeURIComponent(distributedRunId)}/${action}`,
        action === 'cancel' ? { data: { reason: 'Playwright distributed recipe QA cleanup.' } } : undefined
    );
    expect(response.status()).toBe(202);
    return decodeControlDistributedRunSnapshot(await response.json()).fold(throwBoundaryError, (value) => value);
}

export function throwBoundaryError(issue: string): never {
    throw new Error(`Invalid control response: ${issue}`);
}
