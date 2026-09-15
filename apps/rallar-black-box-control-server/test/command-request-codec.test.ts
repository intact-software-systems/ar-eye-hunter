import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { assertEquals } from '@std/assert';

import {
    decodeBulkCommandRequest,
    decodeCommandRequest,
    toBulkCommandInputs
} from '../src/routes/command-request-codec.ts';
import { assertRight } from './support/control-service-test-fixtures.ts';

const HEALTH_COMMAND: RallarBlackBoxTestCommand = { kind: 'health' };

Deno.test('command request decoding rejects a missing or invalid command', () => {
    assertEquals(decodeCommandRequest({}).left, 'Command request requires command.');
    assertEquals(decodeCommandRequest([HEALTH_COMMAND]).left, 'Command request requires command.');
    assertEquals(decodeCommandRequest({ command: { kind: 'not-a-command' } }).left !== undefined, true);
});

Deno.test('command request decoding treats null identifiers as absent and rejects mistyped ones', () => {
    assertEquals(
        assertRight(decodeCommandRequest({ command: HEALTH_COMMAND, commandId: null, deadlineEpochMs: null })),
        { command: HEALTH_COMMAND, commandId: undefined, deadlineEpochMs: undefined }
    );
    assertEquals(
        decodeCommandRequest({ command: HEALTH_COMMAND, commandId: 42 }).left,
        'Command request commandId must be a string.'
    );
    assertEquals(
        decodeCommandRequest({ command: HEALTH_COMMAND, deadlineEpochMs: '2000' }).left,
        'Command request deadlineEpochMs must be a number.'
    );
});

Deno.test('bulk command decoding requires a command and at least one non-blank agent id', () => {
    assertEquals(decodeBulkCommandRequest({ agentIds: ['agent-1'] }).left, 'Bulk command request requires command.');
    assertEquals(
        decodeBulkCommandRequest({ command: HEALTH_COMMAND, agentIds: [' ', 7] }).left,
        'Bulk command request requires agentIds.'
    );
});

Deno.test('bulk command inputs keep an explicit single-agent id and suffix shared ids per agent', () => {
    const single = assertRight(decodeBulkCommandRequest({ command: HEALTH_COMMAND, agentIds: ['a'], commandId: 'x' }));
    const shared = assertRight(
        decodeBulkCommandRequest({ command: HEALTH_COMMAND, agentIds: [' a ', 'b/c', '///'], commandIdPrefix: 'p' })
    );

    assertEquals(
        toBulkCommandInputs({ runId: 'run-1', request: single, nowEpochMs: 5 }).map((input) => input.commandId),
        ['x']
    );
    assertEquals(
        toBulkCommandInputs({ runId: 'run-1', request: shared, nowEpochMs: 5 }).map((input) => input.commandId),
        ['p-a', 'p-b-c', 'p-agent']
    );
});

Deno.test('bulk command inputs fall back to generated ids and carry the deadline', () => {
    const request = assertRight(
        decodeBulkCommandRequest({ command: HEALTH_COMMAND, agentIds: ['a', 'b'], deadlineEpochMs: 9 })
    );

    assertEquals(toBulkCommandInputs({ runId: 'run-1', request, nowEpochMs: 5 }), [
        { runId: 'run-1', agentId: 'a', commandId: 'bulk-5-1', command: HEALTH_COMMAND, deadlineEpochMs: 9 },
        { runId: 'run-1', agentId: 'b', commandId: 'bulk-5-2', command: HEALTH_COMMAND, deadlineEpochMs: 9 }
    ]);
});
