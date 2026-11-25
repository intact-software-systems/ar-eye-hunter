import { expect, type APIRequestContext } from '@playwright/test';

import { CONTROL_REQUEST_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-request-timeout-ms.ts';

import type { ControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { FULL_STACK_CONTROL_BASE_URL } from './full-stack-helpers.ts';
import { readDisposedResponse } from './read-disposed-response.ts';

export async function createDistributedRun(
    request: APIRequestContext,
    manifest: RallarBlackBoxDistributedRunManifest
): Promise<ControlDistributedRunSnapshot> {
    const response = await request.post(`${FULL_STACK_CONTROL_BASE_URL}/distributed-runs`, {
        data: { manifest },
        timeout: CONTROL_REQUEST_TIMEOUT_MS
    });
    const body = await readDisposedResponse(response, async (created) => {
        expect(created.status()).toBe(201);
        return await created.json();
    });
    return decodeControlDistributedRunSnapshot(body).fold(throwBoundaryError, (value) => value);
}

export async function mutateDistributedRun(
    request: APIRequestContext,
    distributedRunId: string,
    action: 'stage' | 'start' | 'cancel'
): Promise<ControlDistributedRunSnapshot> {
    const response = await request.post(
        `${FULL_STACK_CONTROL_BASE_URL}/distributed-runs/${encodeURIComponent(distributedRunId)}/${action}`,
        {
            data: action === 'cancel' ? { reason: 'Playwright distributed recipe QA cleanup.' } : undefined,
            timeout: CONTROL_REQUEST_TIMEOUT_MS
        }
    );
    const body = await readDisposedResponse(response, async (accepted) => {
        expect(accepted.status()).toBe(202);
        return await accepted.json();
    });
    return decodeControlDistributedRunSnapshot(body).fold(throwBoundaryError, (value) => value);
}

export function throwBoundaryError(issue: string): never {
    throw new Error(`Invalid control response: ${issue}`);
}
