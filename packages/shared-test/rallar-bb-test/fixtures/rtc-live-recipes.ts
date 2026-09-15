import type { RallarBlackBoxDistributedGroupRef } from '../distributed-run.ts';
import { createRallarBlackBoxProviderParityRecipe } from '../provider-parity/create-rallar-black-box-provider-parity-recipe.ts';
import type { RallarBlackBoxProviderParityRecipeOptions } from '../provider-parity/provider-parity-contracts.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import type { RallarBlackBoxLiveRecipeOptions } from './live-rtc-setup.ts';
import {
    computeRtcConnectCommandTimeoutMs,
    createRallarBlackBoxEnsureGroupCommands,
    defaultRallarBlackBoxGroup,
    groupRoomRef,
    RALLAR_BLACK_BOX_LIVE_API_BASE_URL,
    rtcConnectReadiness
} from './live-rtc-setup.ts';

export function createRallarBlackBoxRtcSmokeRecipe(
    options: RallarBlackBoxLiveRecipeOptions = {}
): RallarBlackBoxTestRecipe {
    const group = options.group ?? defaultRallarBlackBoxGroup();
    const roomRef = groupRoomRef(group);
    const actor = options.actor ?? '{auth.clientId}';
    const connection = options.connection ?? 'aliceRtc';

    return {
        schemaVersion: 1,
        recipeId: 'rtc-smoke-recipe',
        name: 'RTC smoke recipe',
        continueOnFailure: false,
        metadata: {
            profile: 'rtc-smoke',
            group
        },
        commands: [
            ...createRallarBlackBoxEnsureGroupCommands({
                commandPrefix: 'rtc-smoke',
                requestPrefix: 'rtc-smoke',
                group,
                actor
            }),
            toSmokeConnectCommand({ options, group, roomRef, actor, connection }),
            toSmokeSendCommand({ options, group, roomRef, actor, connection }),
            {
                kind: 'stats',
                commandId: 'rtc-stats-snapshot'
            }
        ]
    };
}

export function createRallarBlackBoxProviderParityLiveRecipe(
    options: RallarBlackBoxLiveRecipeOptions = {}
): RallarBlackBoxTestRecipe {
    const group = options.group ?? defaultRallarBlackBoxGroup();
    const roomRef = groupRoomRef(group);
    const actor = options.actor ?? '{auth.clientId}';
    const context: ScopedParityContext = {
        options,
        group,
        roomRef,
        actor,
        connection: options.connection ?? 'aliceRtc',
        apiBaseUrl: options.apiBaseUrl ?? RALLAR_BLACK_BOX_LIVE_API_BASE_URL
    };
    const baseRecipe = createRallarBlackBoxProviderParityRecipe(toProviderParityLiveOptions(context));
    const configureCommand = baseRecipe.commands[0];
    const scopedCommands = baseRecipe.commands.slice(1).map((command) => toScopedParityCommand(command, context));

    return {
        ...baseRecipe,
        metadata: {
            ...baseRecipe.metadata,
            group,
            selfContainedSetup: true
        },
        commands: [
            configureCommand,
            ...createRallarBlackBoxEnsureGroupCommands({
                commandPrefix: 'parity',
                requestPrefix: 'provider-parity',
                group,
                actor
            }),
            ...scopedCommands
        ]
    };
}

interface LiveRecipeContext {
    readonly options: RallarBlackBoxLiveRecipeOptions;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly roomRef: RallarBlackBoxDistributedGroupRef;
    readonly actor: string;
    readonly connection: string;
}

function toSmokeConnectCommand(context: LiveRecipeContext): RallarBlackBoxTestCommand {
    const { options, group, roomRef, actor, connection } = context;
    return {
        kind: 'rtc.connect',
        commandId: 'rtc-connect-alice',
        connection,
        actor,
        roomId: group.groupId,
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        roomRef,
        transport: 'realtime',
        timeoutMs: computeRtcConnectCommandTimeoutMs(options, 5_000),
        readiness: rtcConnectReadiness(options)
    };
}

function toSmokeSendCommand(context: LiveRecipeContext): RallarBlackBoxTestCommand {
    const { options, group, roomRef, actor, connection } = context;
    return {
        kind: 'rtc.send',
        commandId: 'rtc-send-greeting',
        connection,
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        roomRef,
        transport: 'realtime',
        send: {
            roomId: group.groupId,
            roomRef,
            data: {
                topic: 'black-box.smoke',
                text: 'hello from local workbench',
                actor
            }
        },
        timeoutMs: 3_000
    };
}

interface ScopedParityContext {
    readonly options: RallarBlackBoxLiveRecipeOptions;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly roomRef: RallarBlackBoxDistributedGroupRef;
    readonly actor: string;
    readonly connection: string;
    readonly apiBaseUrl: string;
}

function toScopedParityCommand(
    command: RallarBlackBoxTestCommand,
    context: ScopedParityContext
): RallarBlackBoxTestCommand {
    switch (command.kind) {
        case 'rtc.connect':
            return toScopedParityConnectCommand(command, context);
        case 'rtc.send':
            return toScopedParitySendCommand(command, context);
        default:
            return command;
    }
}

function toScopedParityConnectCommand(
    command: Extract<RallarBlackBoxTestCommand, Readonly<{ kind: 'rtc.connect'; }>>,
    context: ScopedParityContext
): RallarBlackBoxTestCommand {
    const { options, group, roomRef, actor, apiBaseUrl } = context;
    return {
        ...command,
        actor,
        roomId: group.groupId,
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        roomRef,
        timeoutMs: computeRtcConnectCommandTimeoutMs(options, command.timeoutMs ?? 5_000),
        rallar: {
            ...command.rallar,
            ...toParityRallarScope({ group, roomRef, apiBaseUrl })
        },
        readiness: rtcConnectReadiness(options)
    };
}

function toScopedParitySendCommand(
    command: Extract<RallarBlackBoxTestCommand, Readonly<{ kind: 'rtc.send'; }>>,
    context: ScopedParityContext
): RallarBlackBoxTestCommand {
    const { group, roomRef } = context;
    const send = command.send && typeof command.send === 'object' && !Array.isArray(command.send) ? command.send : {};
    return {
        ...command,
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        roomRef,
        send: { ...send, roomId: group.groupId, roomRef }
    };
}

function toProviderParityLiveOptions(context: ScopedParityContext): RallarBlackBoxProviderParityRecipeOptions {
    const { group, roomRef, actor, apiBaseUrl } = context;
    return {
        providerMode: 'browser-rallar',
        includeDemoAuth: false,
        apiBaseUrl,
        actor,
        roomId: group.groupId,
        connection: context.connection,
        directPeerIds: ['{rtc.readyPeerIds[0]}'],
        multicastPeerIds: ['{rtc.readyPeerIds}'],
        rallar: toParityRallarScope({ group, roomRef, apiBaseUrl }),
        control: {
            providerMode: 'browser-rallar',
            parity: true
        }
    };
}

function toParityRallarScope(
    scope: Pick<ScopedParityContext, 'group' | 'roomRef' | 'apiBaseUrl'>
): RallarBlackBoxTestRecord {
    return {
        apiBaseUrl: scope.apiBaseUrl,
        applicationId: scope.group.applicationId,
        workspaceId: scope.group.workspaceId,
        scope: {
            applicationId: scope.group.applicationId,
            workspaceId: scope.group.workspaceId
        },
        roomRef: scope.roomRef
    };
}
