import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { createRallarBlackBoxEnsureGroupCommands } from '@shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
export interface HetznerRoomProofInput {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly prefix: string;
    readonly connection: string;
    readonly controlTopic: string;
    readonly leakProbeTopic: string;
    readonly groupRequestId: string;
    readonly memberRequestId: string;
    readonly absencePurpose: string;
}
export function toHetznerRoomProofCommands(input: HetznerRoomProofInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...createRallarBlackBoxEnsureGroupCommands({
            commandPrefix: input.prefix,
            requestPrefix: input.prefix,
            group: input.group,
            groupRequestId: input.groupRequestId,
            memberRequestId: input.memberRequestId
        }),
        toRoomProofConnect(input),
        toRoomProofSend(input),
        toRoomProofPositiveWait(input),
        toRoomProofAbsenceWait(input)
    ];
}

function toRoomProofConnect(input: HetznerRoomProofInput): RallarBlackBoxTestCommand {
    const group = input.group;
    const roomRef = group;
    return {
        kind: 'rtc.connect',
        commandId: `${input.prefix}-connect`,
        connection: input.connection,
        actor: '{auth.clientId}',
        roomId: group.groupId,
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        roomRef,
        transport: 'realtime',
        timeoutMs: 15_000,
        readiness: {
            minReadyPeers: 1,
            timeoutMs: 10_000,
            intervalMs: 100
        }
    };
}

function toRoomProofSend(input: HetznerRoomProofInput): RallarBlackBoxTestCommand {
    const group = input.group;
    const roomRef = group;
    return {
        kind: 'rtc.send',
        commandId: `${input.prefix}-send-control`,
        connection: input.connection,
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        roomRef,
        transport: 'realtime',
        send: {
            roomId: group.groupId,
            roomRef,
            data: {
                topic: input.controlTopic,
                marker: 'same-room-positive-control',
                actor: '{auth.clientId}'
            }
        },
        timeoutMs: 3_000
    };
}

function toRoomProofPositiveWait(input: HetznerRoomProofInput): RallarBlackBoxTestCommand {
    const group = input.group;
    const roomRef = group;
    return {
        kind: 'wait',
        commandId: `${input.prefix}-positive-control`,
        timeoutMs: 10_000,
        metadata: {
            purpose: 'Same-room positive control: the control frame must arrive ' +
                'before any absence claim.'
        },
        match: {
            kind: 'message',
            connection: input.connection,
            topic: 'rallar.browser.realtime.message',
            payloadPath: 'data.topic',
            equals: input.controlTopic
        }
    };
}

function toRoomProofAbsenceWait(input: HetznerRoomProofInput): RallarBlackBoxTestCommand {
    const group = input.group;
    const roomRef = group;
    return {
        kind: 'wait',
        commandId: `${input.prefix}-no-leak-probe`,
        absent: true,
        timeoutMs: 4_000,
        metadata: {
            purpose: input.absencePurpose
        },
        match: {
            kind: 'message',
            connection: input.connection,
            topic: 'rallar.browser.realtime.message',
            payloadPath: 'data.topic',
            equals: input.leakProbeTopic
        }
    };
}
