import type {
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeJsonValue, decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';

import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import {
    formatJsonSchemaValidationErrors,
    validateJsonSchema
} from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { ManualWorkbenchValues } from '../manual-workbench.ts';

export interface ManualRtcScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope?: RallarBlackBoxTestRecord;
    readonly roomRef?: RallarBlackBoxTestRecord;
    readonly minSnapshotVersion?: number;
}

export function toManualCommandId(action: string, sequence: number): string {
    return `manual-${action}-${sequence}`;
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
        const parsed = decodeJsonValue(JSON.parse(trimmed));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? decodeRecord(parsed)
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
    const applicationId = toOptionalText(values.applicationId);
    const workspaceId = toOptionalText(values.workspaceId);
    return applicationId && groupId
        ? { applicationId, ...(workspaceId ? { workspaceId } : {}), groupId }
        : undefined;
}

/** Validates authored intent without materializing runtime defaults. */
export function decodeManualRtcReadinessText(text: string): Either<string, RallarBlackBoxTestRtcConnectCommand> {
    try {
        const parsed: unknown = text.trim() === '' ? undefined : JSON.parse(text);
        const command = { kind: 'rtc.connect', ...(parsed === undefined ? {} : { readiness: parsed }) };
        const validation = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command);
        return validation.ok
            ? Either.ofRight(command as RallarBlackBoxTestRtcConnectCommand)
            : Either.ofLeft(formatJsonSchemaValidationErrors(validation.errors));
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error.message : String(error));
    }
}
