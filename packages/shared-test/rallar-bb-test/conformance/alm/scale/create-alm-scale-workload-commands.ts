import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../rallar-black-box-test-contracts.ts';

import { createAlmScaleLifecycleArrival, createAlmScaleShotArrivals } from './create-alm-scale-arrival-commands.ts';
import { createAlmScalePayload } from './create-alm-scale-payload.ts';
import type { AlmScaleRecipeInput } from './create-alm-scale-recipes.ts';

interface AlmScaleSendInput {
    readonly prefix: string;
    readonly handleId: string;
    readonly sequence: number | undefined;
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
            createReceivedCommand(prefix, 'intent', (input.participantCount - 1) * 6),
            createAlmScaleShotArrivals(input)
        ]
        : [
            { ...createReceivedCommand(prefix, 'event', 1), commandId: `${prefix}-received-start` },
            ...createAlmScaleLifecycleArrival(input, 'started'),
            createShotWorkload(input),
            complete,
            createReceivedCommand(prefix, 'event', 2),
            ...createAlmScaleLifecycleArrival(input, 'ended')
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
    const resultId = `${prefix}-traffic:g1:workload:c1:${prefix}-window:g1:commands:c${commandOffset + 3}:${receiptId}`;
    return [
        createSendCommand(input, {
            prefix,
            handleId,
            kind: event === 'start' ? 'started' : 'ended',
            sequence: undefined
        }),
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

function createShotWorkload(input: AlmScaleRecipeInput): RallarBlackBoxTestCommand {
    const prefix = 'alm-scale-player';
    return {
        kind: 'parallel',
        commandId: `${prefix}-shot-workload`,
        maxConcurrency: 1,
        groups: [{
            groupId: 'shots',
            commands: [{
                kind: 'parallel',
                commandId: `${prefix}-scheduled-shots`,
                maxConcurrency: 6,
                groups: Array.from({ length: 6 }, (_, index) => ({
                    groupId: `shot-${index + 1}`,
                    commands: createShotBranch(input, index + 1)
                }))
            }, createShotVerificationLoop()]
        }]
    };
}

function createShotBranch(input: AlmScaleRecipeInput, sequence: number): readonly RallarBlackBoxTestCommand[] {
    const prefix = 'alm-scale-player';
    const handleId = `${prefix}-shot-${sequence}`;
    return [
        ...(sequence === 1 ? [] : [{
            kind: 'wait' as const,
            commandId: `${handleId}-offset`,
            match: { kind: 'diagnostic' as const, topic: 'rallar.black-box.alm.scale.shot-offset' },
            absent: true as const,
            timeoutMs: (sequence - 1) * 5_000
        }]),
        createSendCommand(input, { prefix, handleId, kind: 'shot', sequence }),
        {
            kind: 'messages.observe',
            commandId: `${handleId}-acknowledged`,
            connection: prefix,
            handleId,
            state: ['acknowledged'],
            timeoutMs: 30_000
        }
    ];
}

function createShotVerificationLoop(): RallarBlackBoxTestCommand {
    const prefix = 'alm-scale-player';
    const resultId =
        `${prefix}-traffic:g1:workload:c1:${prefix}-window:g1:commands:c4:${prefix}-shot-workload:g1:shots:c2:${prefix}-shots:i{loop.iteration}:c1:${prefix}-shot-receipt`;
    return {
        kind: 'loop',
        commandId: `${prefix}-shots`,
        count: 6,
        intervalMs: 0,
        commands: [
            {
                kind: 'messages.receipts',
                commandId: `${prefix}-shot-receipt`,
                connection: prefix,
                handleId: `${prefix}-shot-{loop.iteration}`,
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
        commandId: `${send.prefix}-${send.kind}${send.sequence === undefined ? '' : `-${send.sequence}`}-send`,
        connection: send.prefix,
        handleId: send.handleId,
        carrier: 'rtc-with-ws-fallback',
        roomRef: { ...input.group },
        topicId: 'room.ar-eye-hunter.director',
        typeId: `room.ar-eye-hunter.director.${send.kind === 'shot' ? 'intent' : 'event'}.v1`,
        payload: createAlmScalePayload(input, send.kind, send.sequence),
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
