import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

export function toHetznerManifestCommands(manifest: RallarBlackBoxDistributedRunManifest): readonly RallarBlackBoxTestCommand[] {
    return manifest.recipes.flatMap((selection) => toHetznerRecipeCommands(selection.recipe?.commands ?? []));
}

export function toHetznerRecipeCommands(commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestCommand[] {
    return commands.flatMap((command) => [
        command,
        ...(command.kind === 'loop' ? toHetznerRecipeCommands(command.commands) : []),
        ...(command.kind === 'parallel' ? command.groups.flatMap((group) => toHetznerRecipeCommands(group.commands)) : [])
    ]);
}
