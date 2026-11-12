import * as Playwright from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { vi } from 'vitest';

import { parseControlServerMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

export interface RecordedControlCommand {
    readonly url: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly command: RallarBlackBoxTestCommand;
}

export interface RecordingControlRequest {
    readonly request: Playwright.APIRequestContext;
    /** Every command the lane enqueued, decoded as the control server decodes it, in enqueue order. */
    readonly posted: readonly RecordedControlCommand[];
    close(): Promise<void>;
}

/**
 * A request whose every command enqueue an owned HTTP server accepts with 202. The agent comes from the actual
 * `/runs/<run>/agents/<agent>/commands` URL; a body the control server would refuse fails the enqueue. A test that
 * orders the enqueues among its other events passes `onPosted`, told of each command as it is recorded.
 */
export async function openRecordingControlRequest(
    runId: string,
    onPosted: (posted: RecordedControlCommand) => void = () => {}
): Promise<RecordingControlRequest> {
    const server = createServer((_request, response) => {
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('Expected the owned HTTP server address.');
    }
    const posted: RecordedControlCommand[] = [];
    const request = await Playwright.request.newContext();
    const post = request.post.bind(request);
    vi.spyOn(request, 'post').mockImplementation(async (url, options) => {
        const data = options?.data;
        if (!isJsonRecordValue(data) || typeof data.commandId !== 'string') {
            throw new Error('Expected the actual control HTTP command body.');
        }
        const agentId = decodeURIComponent(new URL(url).pathname.split('/').at(-2)!);
        const decoded = parseControlServerMessage(
            { kind: 'command', protocolVersion: 1, runId, agentId, ...data },
            { runId, agentId }
        );
        if (!decoded.ok) {
            throw new Error(decoded.error);
        }
        const recorded = { url, agentId, commandId: data.commandId, command: decoded.envelope.command };
        posted.push(recorded);
        onPosted(recorded);
        return await post(`http://127.0.0.1:${address.port}`, options);
    });
    return {
        request,
        posted,
        close: async () => {
            await request.dispose();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    };
}
