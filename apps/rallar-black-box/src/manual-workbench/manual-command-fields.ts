import type { RallarBlackBoxTestRecord } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ManualWorkbenchValues } from '../manual-workbench.ts';

export interface ManualRtcScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope?: RallarBlackBoxTestRecord;
    readonly roomRef?: RallarBlackBoxTestRecord;
    readonly minSnapshotVersion?: number;
}

export function toOptionalText(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function toTimeoutMs(value: ManualWorkbenchValues): number | undefined {
    return Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
        ? Math.round(value.timeoutMs)
        : undefined;
}

export function toTargets(values: ManualWorkbenchValues): readonly string[] {
    if (values.deliveryMode === 'broadcast') {
        return [];
    }

    if (values.deliveryMode === 'direct') {
        const target = toOptionalText(values.targetClient);
        return target ? [target] : [];
    }

    return toTargetIds(values.multicastClients);
}

export function toScopedRtcFields(
    values: ManualWorkbenchValues
): ManualRtcScope {
    const applicationId = toOptionalText(values.applicationId);
    const workspaceId = toOptionalText(values.workspaceId);
    const scope = parseOptionalRecord(values.scopeText);
    const roomRef = parseOptionalRecord(values.roomRefText) ?? toDefaultRoomRef(values);
    const minSnapshotVersion = toMinSnapshotVersion(values);
    return {
        ...(applicationId ? { applicationId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(scope ? { scope } : {}),
        ...(roomRef ? { roomRef } : {}),
        ...(minSnapshotVersion !== undefined ? { minSnapshotVersion } : {})
    };
}

function toTargetIds(value: string): readonly string[] {
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function parseOptionalRecord(text: string): RallarBlackBoxTestRecord | undefined {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return undefined;
    }

    try {
        const parsed: RallarMessagePayload = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as RallarBlackBoxTestRecord
            : undefined;
    }
    catch {
        return undefined;
    }
}

function toMinSnapshotVersion(value: ManualWorkbenchValues): number | undefined {
    return Number.isFinite(value.minSnapshotVersion) && value.minSnapshotVersion > 0
        ? Math.round(value.minSnapshotVersion)
        : undefined;
}

function toDefaultRoomRef(values: ManualWorkbenchValues): RallarBlackBoxTestRecord | undefined {
    const groupId = toOptionalText(values.groupId);
    return groupId ? { groupId } : undefined;
}
