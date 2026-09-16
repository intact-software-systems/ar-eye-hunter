import { uniqueSortedValues } from '../distributed/unique-sorted-values.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestCrdtTransport,
    RallarBlackBoxTestRecipe
} from '../rallar-black-box-test-contracts.ts';
import { decodePositiveInteger, decodeRecord } from '../runtime/decode-runtime-result-values.ts';

export type DistributedRecipeCommandPreview = Readonly<{
    manifestCommandCount: number;
    effectiveCommandCount: number;
    effectiveFrameCount?: number;
    label: string;
}>;

/**
 * Count-based authoring preview. Loop pacing and command limits belong to the
 * preflight estimate, which deliberately reports different numbers.
 */
export function distributedRecipeCommandPreview(
    recipe: RallarBlackBoxTestRecipe
): DistributedRecipeCommandPreview {
    const manifestCommandCount = recipe.commands.length;
    const effectiveCommandCount = recipe.commands.reduce(
        (sum, command) => sum + computeEffectiveCommandCount(command),
        0
    );
    const hasStreamFrames = recipe.commands.some((command) =>
        toDistributedRecipeCommandKinds(command).includes('rtc.stream')
    );
    const effectiveFrameCount = computeRecipeMetadataFrameCount(recipe) ??
        decodeFirstPositiveIntegerFrom(recipe.commands, computeEffectiveFrameCount);
    const labelParts = [
        `${manifestCommandCount} manifest command${manifestCommandCount === 1 ? '' : 's'}`
    ];
    if (effectiveCommandCount !== manifestCommandCount) {
        labelParts.push(`${effectiveCommandCount} effective operation${effectiveCommandCount === 1 ? '' : 's'}`);
    }
    if (effectiveFrameCount !== undefined) {
        labelParts.push(`${effectiveFrameCount} ${hasStreamFrames ? 'stream ' : ''}frames`);
    }

    return {
        manifestCommandCount,
        effectiveCommandCount,
        effectiveFrameCount,
        label: labelParts.join(' - ')
    };
}

export function distributedRecipeCommandKinds(
    recipe: RallarBlackBoxTestRecipe
): readonly RallarBlackBoxTestCommandKind[] {
    return uniqueSortedValues(recipe.commands.flatMap(toDistributedRecipeCommandKinds));
}

export function distributedRecipeCrdtTransports(
    recipe: RallarBlackBoxTestRecipe
): readonly RallarBlackBoxTestCrdtTransport[] {
    return uniqueSortedValues(recipe.commands.flatMap(toCrdtTransports));
}

export function toDistributedRecipeCommandKinds(
    command: RallarBlackBoxTestCommand
): readonly RallarBlackBoxTestCommandKind[] {
    return uniqueSortedValues([command.kind, ...toNestedCommandKinds(command)]);
}

export function hasCrdtCommandKind(
    commandKinds: readonly RallarBlackBoxTestCommandKind[]
): boolean {
    return commandKinds.some((kind) => kind.startsWith('crdt.'));
}

export function computeEffectiveCommandCount(command: RallarBlackBoxTestCommand): number {
    if (command.kind === 'loop') {
        const childCommandCount = command.commands.reduce(
            (sum, childCommand) => sum + computeEffectiveCommandCount(childCommand),
            0
        );
        return childCommandCount * (decodePositiveInteger(command.count) ?? 1);
    }

    if (command.kind === 'parallel') {
        return command.groups.reduce(
            (sum, group) =>
                sum + group.commands.reduce(
                    (groupSum, childCommand) => groupSum + computeEffectiveCommandCount(childCommand),
                    0
                ),
            0
        );
    }

    return 1;
}

export function computeEffectiveFrameCount(command: RallarBlackBoxTestCommand): number | undefined {
    const metadata = decodeRecord(command.metadata);
    const frameCount = decodeFirstPositiveInteger(
        decodeRecord(metadata.realtime).frameCount,
        metadata.frameCount
    );
    if (frameCount !== undefined) {
        return frameCount;
    }

    if (command.kind === 'rtc.stream') {
        return decodePositiveInteger(command.count);
    }

    if (command.kind === 'loop') {
        return decodeFirstPositiveIntegerFrom(command.commands, computeEffectiveFrameCount);
    }

    return undefined;
}

export function computeRecipeMetadataFrameCount(
    recipe: RallarBlackBoxTestRecipe
): number | undefined {
    const metadata = decodeRecord(recipe.metadata);
    return decodeFirstPositiveInteger(decodeRecord(metadata.realtime).frameCount, metadata.frameCount);
}

function decodeFirstPositiveInteger(...values: readonly unknown[]): number | undefined {
    return values.find((value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0);
}

export function decodeFirstPositiveIntegerFrom<Value>(
    values: Iterable<Value>,
    select: (value: Value) => number | undefined
): number | undefined {
    for (const value of values) {
        const candidate = select(value);
        if (candidate !== undefined && Number.isInteger(candidate) && candidate > 0) {
            return candidate;
        }
    }
    return undefined;
}

function toNestedCommandKinds(
    command: RallarBlackBoxTestCommand
): readonly RallarBlackBoxTestCommandKind[] {
    switch (command.kind) {
        case 'loop':
            return command.commands.flatMap(toDistributedRecipeCommandKinds);
        case 'parallel':
            return command.groups.flatMap((group) => group.commands.flatMap(toDistributedRecipeCommandKinds));
        case 'recipe.load':
        case 'recipe.run':
            return command.recipe?.commands.flatMap(toDistributedRecipeCommandKinds) ?? [];
        default:
            return [];
    }
}

function toCrdtTransports(
    command: RallarBlackBoxTestCommand
): readonly RallarBlackBoxTestCrdtTransport[] {
    switch (command.kind) {
        case 'crdt.open':
        case 'crdt.sync':
            return command.transport ? [command.transport] : [];
        case 'crdt.wait':
            return command.sync && typeof command.sync === 'object' && command.sync.transport
                ? [command.sync.transport]
                : [];
        case 'loop':
            return command.commands.flatMap(toCrdtTransports);
        case 'parallel':
            return command.groups.flatMap((group) => group.commands.flatMap(toCrdtTransports));
        case 'recipe.load':
        case 'recipe.run':
            return command.recipe?.commands.flatMap(toCrdtTransports) ?? [];
        default:
            return [];
    }
}
