import { expect, test } from 'bun:test';

import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import {
    decodeBulkCommandRequest,
    decodeCommandRequest,
    toBulkCommandInputs
} from '../src/routes/command-request-codec.ts';
import { assertRight } from './support/control-service-test-fixtures.ts';

const HEALTH_COMMAND: RallarBlackBoxTestCommand = { kind: 'health' };

test('command request decoding rejects a missing or invalid command', () => {
    expect(decodeCommandRequest({}).left).toEqual('Command request requires command.');
    expect(decodeCommandRequest([HEALTH_COMMAND]).left).toEqual('Command request requires command.');
    expect(decodeCommandRequest({ command: { kind: 'not-a-command' } }).left !== undefined).toEqual(true);
});

test('command request decoding treats null identifiers as absent and rejects mistyped ones', () => {
    expect(assertRight(decodeCommandRequest({ command: HEALTH_COMMAND, commandId: null, deadlineEpochMs: null }))).toEqual({
        command: HEALTH_COMMAND,
        commandId: undefined,
        deadlineEpochMs: undefined
    });
    expect(decodeCommandRequest({ command: HEALTH_COMMAND, commandId: 42 }).left).toEqual('Command request commandId must be a string.');
    expect(decodeCommandRequest({ command: HEALTH_COMMAND, deadlineEpochMs: '2000' }).left).toEqual('Command request deadlineEpochMs must be a number.');
});

test('bulk command decoding requires a command and at least one non-blank agent id', () => {
    expect(decodeBulkCommandRequest({ agentIds: ['agent-1'] }).left).toEqual('Bulk command request requires command.');
    expect(decodeBulkCommandRequest({ command: HEALTH_COMMAND, agentIds: [' ', 7] }).left).toEqual('Bulk command request requires agentIds.');
});

test('bulk command inputs keep an explicit single-agent id and suffix shared ids per agent', () => {
    const single = assertRight(decodeBulkCommandRequest({ command: HEALTH_COMMAND, agentIds: ['a'], commandId: 'x' }));
    const shared = assertRight(
        decodeBulkCommandRequest({ command: HEALTH_COMMAND, agentIds: [' a ', 'b/c', '///'], commandIdPrefix: 'p' })
    );

    expect(toBulkCommandInputs({ runId: 'run-1', request: single, nowEpochMs: 5 }).map((input) => input.commandId)).toEqual(['x']);
    expect(toBulkCommandInputs({ runId: 'run-1', request: shared, nowEpochMs: 5 }).map((input) => input.commandId)).toEqual(['p-a', 'p-b-c', 'p-agent']);
});

test('bulk command inputs fall back to generated ids and carry the deadline', () => {
    const request = assertRight(
        decodeBulkCommandRequest({ command: HEALTH_COMMAND, agentIds: ['a', 'b'], deadlineEpochMs: 9 })
    );

    expect(toBulkCommandInputs({ runId: 'run-1', request, nowEpochMs: 5 })).toEqual([
        { runId: 'run-1', agentId: 'a', commandId: 'bulk-5-1', command: HEALTH_COMMAND, deadlineEpochMs: 9 },
        { runId: 'run-1', agentId: 'b', commandId: 'bulk-5-2', command: HEALTH_COMMAND, deadlineEpochMs: 9 }
    ]);
});
