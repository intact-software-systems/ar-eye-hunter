import type {
    RallarBlackBoxCompositeConformanceCaseId,
    RallarBlackBoxCompositeConformanceRecipeOptions
} from '../composite-conformance.ts';
import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

export function toRecipeId(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): string {
    return [options.recipeIdPrefix, caseId].join('-');
}

export function toScopeFields(options: RallarBlackBoxCompositeConformanceRecipeOptions): RallarBlackBoxTestRecord {
    return {
        applicationId: options.applicationId,
        workspaceId: options.workspaceId,
        roomRef: {
            applicationId: options.applicationId,
            workspaceId: options.workspaceId,
            groupId: options.roomId
        }
    };
}

export function toRecipeMetadata(caseId: RallarBlackBoxCompositeConformanceCaseId): RallarBlackBoxTestRecord {
    return {
        conformance: {
            schemaVersion: 1,
            caseId
        }
    };
}

export function toCommandMetadata(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    commandId: string
): RallarBlackBoxTestRecord {
    return {
        conformance: {
            schemaVersion: 1,
            caseId,
            commandId
        }
    };
}
