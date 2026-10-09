import { createRallarBlackBoxEnsureGroupCommands } from '../../../fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { RESTORED_SESSION_RALLAR } from '../alm-conformance-session-commands.ts';
import type { AlmScaleRecipeInput } from './create-alm-scale-recipes.ts';

export function createAlmScaleSetupCommands(
    input: AlmScaleRecipeInput,
    role: 'director' | 'player'
): readonly RallarBlackBoxTestCommand[] {
    const prefix = `alm-scale-${role}`;
    const ensure = createRallarBlackBoxEnsureGroupCommands({
        commandPrefix: prefix,
        requestPrefix: prefix,
        group: input.group,
        actor: '{auth.clientId}'
    });
    const created = createSetupBarrier(input, prefix, 'group-created');
    return [
        ...(role === 'director' ? [...ensure, created] : [created, ...ensure]),
        createConnectCommand(input, prefix),
        createSetupBarrier(input, prefix, 'connected'),
        createAudienceWait(input, prefix),
        ...(role === 'director'
            ? [{
                kind: 'director.appoint' as const,
                commandId: `${prefix}-appoint`,
                roomRef: { ...input.group },
                timeoutMs: 5_000
            }]
            : []),
        createSetupBarrier(input, prefix, 'appointed'),
        createDirectorWait(input, prefix),
        {
            kind: 'director.status',
            commandId: `${prefix}-ready-status`,
            roomRef: { ...input.group },
            refresh: true,
            timeoutMs: 5_000
        },
        createSetupBarrier(input, prefix, 'setup-complete'),
        { kind: 'storage.counters', commandId: `${prefix}-storage-reset`, reset: true },
        createSetupBarrier(input, prefix, 'traffic-ready')
    ];
}

function createSetupBarrier(input: AlmScaleRecipeInput, prefix: string, phase: string): RallarBlackBoxTestCommand {
    return {
        kind: 'barrier',
        commandId: `${prefix}-${phase}`,
        barrierId: `alm-scale-${phase}`,
        timeoutMs: input.readyTimeoutMs
    };
}

function createConnectCommand(input: AlmScaleRecipeInput, prefix: string): RallarBlackBoxTestCommand {
    return {
        kind: 'rtc.connect',
        commandId: `${prefix}-connect`,
        connection: prefix,
        actor: '{auth.clientId}',
        roomId: input.group.groupId,
        applicationId: input.group.applicationId,
        workspaceId: input.group.workspaceId,
        roomRef: { ...input.group },
        transport: 'messages.rtc',
        timeoutMs: input.readyTimeoutMs + 5_000,
        readiness: { minReadyPeers: 1, timeoutMs: input.readyTimeoutMs, intervalMs: 100 },
        rallar: {
            ...RESTORED_SESSION_RALLAR,
            username: '{auth.username}',
            timeoutMs: input.readyTimeoutMs,
            typeId: 'room.ar-eye-hunter.director.intent.v1',
            topicId: 'room.ar-eye-hunter.director',
            messageSelector: { topicId: 'room.ar-eye-hunter.director' },
            messageTypeIds: ['room.ar-eye-hunter.director.intent.v1', 'room.ar-eye-hunter.director.event.v1']
        }
    };
}

function createAudienceWait(input: AlmScaleRecipeInput, prefix: string): RallarBlackBoxTestCommand {
    const path = `/api/state/apps/${encodeURIComponent(input.group.applicationId)}` +
        `/workspaces/${encodeURIComponent(input.group.workspaceId)}/groups/${encodeURIComponent(input.group.groupId)}`;
    return {
        kind: 'loop',
        commandId: `${prefix}-audience-ready`,
        count: Math.ceil(input.readyTimeoutMs / 200),
        intervalMs: 200,
        timeoutMs: input.readyTimeoutMs,
        until: 'first-success',
        commands: [
            {
                kind: 'http.request',
                commandId: `${prefix}-audience`,
                request: { method: 'GET', path },
                response: { body: 'json', acceptedStatusCodes: [200] },
                timeoutMs: 5_000
            },
            {
                kind: 'assert',
                commandId: `${prefix}-assert-audience`,
                operator: 'equals',
                expected: input.participantCount,
                source:
                    `resultCache.${prefix}-audience-ready:i{loop.iteration}:c1:${prefix}-audience.value.body.activeSessions.length`
            }
        ]
    };
}

function createDirectorWait(input: AlmScaleRecipeInput, prefix: string): RallarBlackBoxTestCommand {
    return {
        kind: 'loop',
        commandId: `${prefix}-director-ready`,
        count: Math.ceil(input.readyTimeoutMs / 200),
        intervalMs: 200,
        timeoutMs: input.readyTimeoutMs,
        until: 'first-success',
        commands: [
            {
                kind: 'director.status',
                commandId: `${prefix}-director-status`,
                roomRef: { ...input.group },
                refresh: true,
                timeoutMs: 5_000
            },
            {
                kind: 'assert',
                commandId: `${prefix}-assert-director-active`,
                operator: 'equals',
                expected: true,
                source:
                    `resultCache.${prefix}-director-ready:i{loop.iteration}:c1:${prefix}-director-status.value.directorStatus.active`
            }
        ]
    };
}
