import { distributedRunRecipeSelectionKey } from '../distributed-run-evidence.ts';
import type { RallarBlackBoxDistributedRunRecipeSelection } from '../distributed-run.ts';

export function toDistributedRunRecipeSelectionId(
    selection: RallarBlackBoxDistributedRunRecipeSelection,
    index = 0
): string {
    return distributedRunRecipeSelectionKey(selection) ?? `recipe-${index + 1}`;
}
