import { createRallarServerAiGeneration } from './create-rallar-server-ai-generation.ts';
import type { CreateRallarServerAiInput, RallarServerAi } from './rallar-server-ai-contracts.ts';

export function createRallarServerAi(
    input: CreateRallarServerAiInput
): RallarServerAi {
    return {
        generateJson: createRallarServerAiGeneration(input)
    };
}
