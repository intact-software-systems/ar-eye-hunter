import type { RallarBlackBoxTestCommand, RallarBlackBoxTestConfig, RallarBlackBoxTestRecipe } from '../types.ts';

type RtcConnectCommand = Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect'; }>;
type RecipeCommandNode = Readonly<{
    command: RallarBlackBoxTestCommand;
    insideLoop: boolean;
}>;
type RuntimeValue = string | number | boolean | bigint | symbol | object | null | undefined;

const ROOM_IDENTITY_REMEDY =
    'provide roomRef or applicationId plus roomId on rtc.connect or the active configure command.';
const RTC_STREAM_READINESS_WARNING = 'RTC stream traffic starts without an explicit rtc.connect readiness contract; ' +
    'frames can race signaling and data-channel readiness.';
const RTC_SEND_READINESS_WARNING = 'RTC send traffic starts without an explicit rtc.connect readiness contract; ' +
    'sends can race signaling and data-channel readiness.';
const LOOPED_RTC_SEND_WARNING = 'Looped RTC sends are especially sensitive to missing ready-peer checks ' +
    'before the first frame.';
const STREAMED_RTC_SEND_WARNING = 'Streamed RTC frames are especially sensitive to missing ready-peer checks ' +
    'before the first frame.';

export function rtcReadinessWarnings(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return [
        ...missingRtcReadinessWarnings(recipe),
        ...validateRtcReadinessRoomIdentity(recipe)
    ];
}

function recipeCommandNodes(
    commands: readonly RallarBlackBoxTestCommand[],
    insideLoop = false
): readonly RecipeCommandNode[] {
    return commands.flatMap((command): readonly RecipeCommandNode[] => {
        const current = [{ command, insideLoop }];
        if (command.kind === 'loop') {
            return [
                ...current,
                ...recipeCommandNodes(command.commands, true)
            ];
        }
        if (command.kind === 'parallel') {
            return [
                ...current,
                ...command.groups.flatMap((group) => recipeCommandNodes(group.commands, insideLoop))
            ];
        }
        if ((command.kind === 'recipe.load' || command.kind === 'recipe.run') && command.recipe) {
            return [
                ...current,
                ...recipeCommandNodes(command.recipe.commands, insideLoop)
            ];
        }
        return current;
    });
}

function hasRtcConnectReadiness(command: RallarBlackBoxTestCommand): boolean {
    return command.kind === 'rtc.connect' && command.readiness !== undefined;
}

function missingRtcReadinessWarnings(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    const nodes = recipeCommandNodes(recipe.commands);
    const sends = nodes.filter((node) => node.command.kind === 'rtc.send' || node.command.kind === 'rtc.stream');
    if (sends.length === 0 || nodes.some((node) => hasRtcConnectReadiness(node.command))) {
        return [];
    }

    const hasStream = sends.some((node) => node.command.kind === 'rtc.stream');
    const warnings = [hasStream ? RTC_STREAM_READINESS_WARNING : RTC_SEND_READINESS_WARNING];
    if (sends.some((node) => node.insideLoop)) {
        warnings.push(LOOPED_RTC_SEND_WARNING);
    }
    if (hasStream) {
        warnings.push(STREAMED_RTC_SEND_WARNING);
    }
    return warnings;
}

function validateRtcReadinessRoomIdentity(
    recipe: RallarBlackBoxTestRecipe
): readonly string[] {
    return validateCommandList(recipe.commands, '$.commands', undefined);
}

function validateCommandList(
    commands: readonly RallarBlackBoxTestCommand[],
    path: string,
    inheritedConfig: RallarBlackBoxTestConfig | undefined
): readonly string[] {
    const warnings: string[] = [];
    let activeConfig = inheritedConfig;

    for (const [index, command] of commands.entries()) {
        const commandPath = `${path}[${index}]`;
        if (command.kind === 'configure') {
            activeConfig = command.config;
            continue;
        }
        warnings.push(...validateCommandRtcReadinessRoomIdentity(
            command,
            commandPath,
            activeConfig
        ));
    }

    return warnings;
}

function validateCommandRtcReadinessRoomIdentity(
    command: RallarBlackBoxTestCommand,
    commandPath: string,
    activeConfig: RallarBlackBoxTestConfig | undefined
): readonly string[] {
    if (command.kind === 'rtc.connect' && command.readiness) {
        return hasExactRoomIdentity(command, activeConfig)
            ? []
            : [
                `${commandPath}: Browser Rallar RTC readiness cannot point-refresh room state ` +
                `without an exact room reference; ${ROOM_IDENTITY_REMEDY}`
            ];
    }
    if (command.kind === 'loop') {
        return validateCommandList(command.commands, `${commandPath}.commands`, activeConfig);
    }
    if (command.kind === 'parallel') {
        return command.groups.flatMap((group, groupIndex) =>
            validateCommandList(
                group.commands,
                `${commandPath}.groups[${groupIndex}].commands`,
                activeConfig
            )
        );
    }
    if ((command.kind === 'recipe.load' || command.kind === 'recipe.run') && command.recipe) {
        return validateCommandList(
            command.recipe.commands,
            `${commandPath}.recipe.commands`,
            activeConfig
        );
    }
    return [];
}

function hasExactRoomIdentity(
    command: RtcConnectCommand,
    activeConfig: RallarBlackBoxTestConfig | undefined
): boolean {
    const configuredRallar = activeConfig?.rallar;
    const commandRallar = command.rallar;
    const roomRefValue = command.roomRef !== undefined
        ? command.roomRef
        : selectedProperty(commandRallar, configuredRallar, 'roomRef');
    const roomRef = recordValue(roomRefValue);
    if (
        roomRef &&
        nonEmptyString(Reflect.get(roomRef, 'applicationId')) &&
        nonEmptyString(Reflect.get(roomRef, 'groupId'))
    ) {
        return true;
    }

    const scopeValue = command.scope !== undefined
        ? command.scope
        : selectedProperty(commandRallar, configuredRallar, 'scope');
    const scope = recordValue(scopeValue);
    const rallarApplicationId = selectedProperty(
        commandRallar,
        configuredRallar,
        'applicationId'
    );
    const applicationId = command.applicationId !== undefined
        ? command.applicationId
        : rallarApplicationId ??
            (scope ? Reflect.get(scope, 'applicationId') : undefined);
    const roomId = command.roomId ?? activeConfig?.roomId;
    return nonEmptyString(applicationId) !== undefined && nonEmptyString(roomId) !== undefined;
}

function selectedProperty(
    preferred: object | undefined,
    fallback: object | undefined,
    property: string
): RuntimeValue {
    if (preferred && Object.prototype.hasOwnProperty.call(preferred, property)) {
        return Reflect.get(preferred, property);
    }
    return fallback ? Reflect.get(fallback, property) : undefined;
}

function recordValue(value: RuntimeValue): object | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}

function nonEmptyString(value: RuntimeValue): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
