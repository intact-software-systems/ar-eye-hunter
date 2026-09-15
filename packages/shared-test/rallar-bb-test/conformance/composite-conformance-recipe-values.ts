import type {
    RallarBlackBoxCompositeConformanceCaseId,
    RallarBlackBoxCompositeConformanceRecipeOptions
} from '../composite-conformance.ts';
import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

export const DEFAULT_CONNECTION = 'conformanceRtc';
export const DEFAULT_WS_CONNECTION = 'conformanceWs';
export const DEFAULT_ROOM_ID = 'rallar-conformance-room';

const DEFAULT_TIMEOUT_MS = 5_000;

export function toRecipeId(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): string {
    return [options.recipeIdPrefix ?? 'composite-conformance', caseId].join('-');
}

export function toTimeoutMs(options: RallarBlackBoxCompositeConformanceRecipeOptions): number {
    return Number.isFinite(options.timeoutMs) && options.timeoutMs !== undefined && options.timeoutMs > 0
        ? Math.round(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
}

export function toScopeFields(options: RallarBlackBoxCompositeConformanceRecipeOptions): RallarBlackBoxTestRecord {
    return {
        applicationId: options.applicationId ?? 'rallar-server',
        workspaceId: options.workspaceId ?? 'default',
        roomRef: {
            applicationId: options.applicationId ?? 'rallar-server',
            workspaceId: options.workspaceId ?? 'default',
            groupId: options.roomId ?? DEFAULT_ROOM_ID
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
