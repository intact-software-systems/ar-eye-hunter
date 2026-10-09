import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../rallar-black-box-test-contracts.ts';

import { createAlmScalePayload } from './create-alm-scale-payload.ts';
import type { AlmScaleRecipeInput } from './create-alm-scale-recipes.ts';

interface AlmScaleSendInput {
    readonly prefix: string;
    readonly handleId: string;
    readonly kind: 'shot' | 'started' | 'ended';
}

interface AlmScaleReceiptInput {
    readonly prefix: string;
    readonly resultId: string;
    readonly count: number;
    readonly mode: 'leader' | 'receiver';
}

export function createAlmScaleWorkloadCommands(
    input: AlmScaleRecipeInput,
    role: 'director' | 'player'
): readonly RallarBlackBoxTestCommand[] {
    const prefix = `alm-scale-${role}`;
    const complete: RallarBlackBoxTestCommand = {
        kind: 'barrier',
        commandId: `${prefix}-shots-complete`,
        barrierId: 'alm-scale-shots-complete',
        timeoutMs: 65_000
    };
    return role === 'director'
        ? [
            ...createLifecycleSendCommands(input, 'start', 0),
            complete,
            ...createLifecycleSendCommands(input, 'end', 9),
            createReceivedCommand(prefix, 'intent', (input.participantCount - 1) * 6)
        ]
        : [
            { ...createReceivedCommand(prefix, 'event', 1), commandId: `${prefix}-received-start` },
            createShotLoop(input),
            complete,
            createReceivedCommand(prefix, 'event', 2)
        ];
}

function createLifecycleSendCommands(
    input: AlmScaleRecipeInput,
    event: 'start' | 'end',
    commandOffset: number
): readonly RallarBlackBoxTestCommand[] {
    const prefix = 'alm-scale-director';
    const receiptId = `${prefix}-${event}-receipt`;
    const handleId = `${prefix}-${event}`;
    const resultId = `${prefix}-traffic:g1:workload:c${commandOffset + 3}:${receiptId}`;
    return [
        createSendCommand(input, { prefix, handleId, kind: event === 'start' ? 'started' : 'ended' }),
        {
            kind: 'messages.observe',
            commandId: `${prefix}-${event}-acknowledged`,
            connection: prefix,
            handleId,
            state: ['acknowledged'],
            timeoutMs: 30_000
        },
        { kind: 'messages.receipts', commandId: receiptId, connection: prefix, handleId, timeoutMs: 5_000 },
        ...createReceiptAssertions({
            prefix: `${prefix}-${event}`,
            resultId,
            count: input.participantCount - 1,
            mode: 'receiver'
        })
    ];
}

function createShotLoop(input: AlmScaleRecipeInput): RallarBlackBoxTestCommand {
    const prefix = 'alm-scale-player';
    const resultId = `${prefix}-traffic:g1:workload:c2:${prefix}-shots:i{loop.iteration}:c3:${prefix}-shot-receipt`;
    const handleId = `${prefix}-shot-{loop.iteration}`;
    return {
        kind: 'loop',
        commandId: `${prefix}-shots`,
        count: 6,
        intervalMs: 5_000,
        commands: [
            createSendCommand(input, { prefix, handleId, kind: 'shot' }),
            {
                kind: 'messages.observe',
                commandId: `${prefix}-shot-acknowledged`,
                connection: prefix,
                handleId,
                state: ['acknowledged'],
                timeoutMs: 30_000
            },
            {
                kind: 'messages.receipts',
                commandId: `${prefix}-shot-receipt`,
                connection: prefix,
                handleId,
                timeoutMs: 5_000
            },
            ...createReceiptAssertions({ prefix: `${prefix}-shot`, resultId, count: 1, mode: 'leader' }),
            ...createLeaderIdentityChecks(prefix, resultId)
        ]
    };
}

function createLeaderIdentityChecks(prefix: string, resultId: string): readonly RallarBlackBoxTestCommand[] {
    const directorSessionId = `{resultCache.${prefix}-ready-status.value.directorStatus.appointment.sessionId}`;
    return ['expectedRecipientPeerIds', 'confirmedRecipientPeerIds'].map((field) => ({
        kind: 'wait',
        commandId: `${prefix}-shot-${field}`,
        timeoutMs: 1_000,
        match: {
            kind: 'diagnostic',
            topic: 'rallar.bb.messages.receipts',
            commandId: resultId,
            payloadPath: 'data',
            contains: `"${field}":["${directorSessionId}"]`
        }
    }));
}

function createSendCommand(input: AlmScaleRecipeInput, send: AlmScaleSendInput): RallarBlackBoxTestMessagesSendCommand {
    return {
        kind: 'messages.send',
        commandId: `${send.prefix}-${send.kind}-send`,
        connection: send.prefix,
        handleId: send.handleId,
        carrier: 'rtc-with-ws-fallback',
        roomRef: { ...input.group },
        topicId: 'room.ar-eye-hunter.director',
        typeId: `room.ar-eye-hunter.director.${send.kind === 'shot' ? 'intent' : 'event'}.v1`,
        payload: createAlmScalePayload(input, send.kind),
        reliability: 'at-least-once',
        durability: 'volatile',
        ack: send.kind === 'shot' ? 'group-leader' : 'all-logical-recipients',
        ttlMs: 30_000,
        timeoutMs: 5_000
    };
}

function createReceiptAssertions(receipt: AlmScaleReceiptInput): readonly RallarBlackBoxTestCommand[] {
    const facts = [
        ['state', 'acknowledged'],
        ['receiptMode', receipt.mode],
        ['expectedRecipientPeerIds.length', receipt.count],
        ['confirmedRecipientPeerIds.length', receipt.count],
        ['unconfirmedRecipientPeerIds.length', 0]
    ] as const;
    return facts.map(([path, expected], index) => ({
        kind: 'assert',
        commandId: `${receipt.prefix}-receipt-check-${index + 1}`,
        source: `resultCache.${receipt.resultId}.value.${path}`,
        operator: 'equals',
        expected
    }));
}

function createReceivedCommand(prefix: string, kind: 'intent' | 'event', count: number): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.received',
        commandId: `${prefix}-received`,
        connection: prefix,
        typeId: `room.ar-eye-hunter.director.${kind}.v1`,
        count,
        windowMs: 30_000,
        timeoutMs: 35_000
    };
}
