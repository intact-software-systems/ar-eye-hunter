export const RALLAR_BLACK_BOX_COMPOSITE_RESULT_PATH_VERSION = 1;
export const RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH = '$';

export interface RallarBlackBoxParallelChildResultPathInput {
    readonly parentPath: string;
    readonly groupIndex: number;
    readonly groupId: string;
    readonly commandIndex: number;
}

export function toRallarBlackBoxLoopChildResultPath(
    parentPath: string,
    iteration: number,
    commandIndex: number
): string {
    return `${parentPath}.iterations[${iteration}].commands[${commandIndex}]`;
}

export function toRallarBlackBoxLoopChildSourceRecipePath(
    parentSourceRecipePath: string,
    commandIndex: number
): string {
    return `${parentSourceRecipePath}.commands[${commandIndex}]`;
}

export function toRallarBlackBoxParallelChildResultPath(input: RallarBlackBoxParallelChildResultPathInput): string {
    return `${input.parentPath}.groups[${input.groupIndex}=${
        encodeURIComponent(input.groupId)
    }].commands[${input.commandIndex}]`;
}

export function toRallarBlackBoxParallelChildSourceRecipePath(
    parentSourceRecipePath: string,
    groupIndex: number,
    commandIndex: number
): string {
    return `${parentSourceRecipePath}.groups[${groupIndex}].commands[${commandIndex}]`;
}
