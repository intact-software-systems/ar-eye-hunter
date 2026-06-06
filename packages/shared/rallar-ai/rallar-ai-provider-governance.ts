import type {
    RallarAiProviderGovernanceMetadata,
    RallarAiProviderTarget,
} from './rallar-ai-types.ts';

export function defineRallarAiProviderGovernanceMetadata(
    metadata: RallarAiProviderGovernanceMetadata,
): RallarAiProviderGovernanceMetadata {
    return { ...metadata };
}

export function isRallarAiProviderAllowedInProduction(
    metadata: Pick<
        RallarAiProviderGovernanceMetadata,
        'productionAllowed' | 'target'
    >,
    target?: RallarAiProviderTarget,
): boolean {
    if (metadata.productionAllowed !== true) {
        return false;
    }
    return target === undefined || metadata.target === target;
}
