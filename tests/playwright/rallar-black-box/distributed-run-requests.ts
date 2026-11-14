import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

import type { ControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { FULL_STACK_CONTROL_BASE_URL } from './full-stack-helpers.ts';

export async function createDistributedRun(
    request: APIRequestContext,
    manifest: RallarBlackBoxDistributedRunManifest
): Promise<ControlDistributedRunSnapshot> {
    const response = await request.post(`${FULL_STACK_CONTROL_BASE_URL}/distributed-runs`, {
        data: { manifest }
    });
    const text = await response.text();
    expect(response.status(), text).toBe(201);
    return JSON.parse(text) as ControlDistributedRunSnapshot;
}

export async function mutateDistributedRun(
    request: APIRequestContext,
    distributedRunId: string,
    action: 'stage' | 'start'
): Promise<ControlDistributedRunSnapshot> {
    return await readAcceptedDistributedRun(
        await request.post(`${toDistributedRunUrl(distributedRunId)}/${action}`)
    );
}

export async function cancelDistributedRun(
    request: APIRequestContext,
    distributedRunId: string,
    reason: string
): Promise<ControlDistributedRunSnapshot> {
    return await readAcceptedDistributedRun(
        await request.post(`${toDistributedRunUrl(distributedRunId)}/cancel`, { data: { reason } })
    );
}

function toDistributedRunUrl(distributedRunId: string): string {
    return `${FULL_STACK_CONTROL_BASE_URL}/distributed-runs/${encodeURIComponent(distributedRunId)}`;
}

async function readAcceptedDistributedRun(response: APIResponse): Promise<ControlDistributedRunSnapshot> {
    const text = await response.text();
    expect(response.status(), text).toBe(202);
    return JSON.parse(text) as ControlDistributedRunSnapshot;
}
