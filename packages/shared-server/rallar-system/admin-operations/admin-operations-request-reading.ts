import type { AdminMetricsResetCategory } from '@shared/api/admin-operations-types.ts';
import { ADMIN_METRICS_RESET_CATEGORIES } from '@shared/api/admin-operations-types.ts';
import { type RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import type { RallarTimingDetails } from '../observability/timing.ts';

interface AdminOperationRequestRecord {
    readonly requestId?: string;
    readonly reason?: string;
    readonly [key: string]: unknown;
}

export function readObject(input: unknown): Record<string, unknown> {
    return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

export function readRecord(input: unknown): Record<string, unknown> | undefined {
    return input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
}

export function readDocument(input: unknown): RallarCrdtDocumentRef {
    const body = readObject(input);
    const document = body.document ?? input;
    if (!document || typeof document !== 'object') {
        throw new Error('CRDT admin operation requires a document ref.');
    }
    return document as RallarCrdtDocumentRef;
}

export function readReason(input: AdminOperationRequestRecord, fallback: string): string {
    return typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason
        : fallback;
}

export function readMetricsResetCategories(
    value: unknown
): readonly AdminMetricsResetCategory[] {
    return readAdminCategoryList({
        value,
        fallback: ADMIN_METRICS_RESET_CATEGORIES,
        allowed: ADMIN_METRICS_RESET_CATEGORIES,
        fieldLabel: 'Admin metrics reset categories',
        itemLabel: 'admin metrics reset category'
    });
}

interface AdminCategoryListInput<TCategory extends string> {
    readonly value: unknown;
    readonly fallback: readonly TCategory[];
    readonly allowed: readonly TCategory[];
    readonly fieldLabel: string;
    readonly itemLabel: string;
}

function readAdminCategoryList<TCategory extends string>(
    input: AdminCategoryListInput<TCategory>
): readonly TCategory[] {
    if (input.value === undefined) {
        return input.fallback;
    }
    if (!Array.isArray(input.value)) {
        throw new Error(`${input.fieldLabel} must be an array.`);
    }

    const allowedSet = new Set<string>(input.allowed);
    return input.value.map((item) => {
        if (typeof item !== 'string' || !allowedSet.has(item)) {
            throw new Error(`Unsupported ${input.itemLabel}: ${String(item)}`);
        }
        return item as TCategory;
    });
}

export function readResultTimingDetails(result: unknown): RallarTimingDetails {
    const body = readObject(result);
    return compactTimingDetails({
        operationStatus: readTimingString(body.status),
        changed: readTimingBoolean(body.changed)
    });
}

export function readTimingTarget(input: unknown): Readonly<{
    applicationId?: string;
    workspaceId?: string;
    groupId?: string;
    documentScope?: string;
    documentType?: string;
    documentId?: string;
}> {
    const body = readObject(input);
    const groupRef = readRecord(body.groupRef);
    const directDocument = readTimingString(body.documentId) ? body : undefined;
    const document = readRecord(body.document) ?? directDocument;
    const roomRef = readRecord(document?.roomRef);

    return {
        applicationId: readTimingString(groupRef?.applicationId) ??
            readTimingString(document?.applicationId) ??
            readTimingString(body.applicationId),
        workspaceId: readTimingString(groupRef?.workspaceId) ??
            readTimingString(document?.workspaceId) ??
            readTimingString(body.workspaceId),
        groupId: readTimingString(groupRef?.groupId) ??
            readTimingString(roomRef?.groupId) ??
            readTimingString(body.groupId),
        documentScope: readTimingString(document?.scope) ?? readTimingString(document?.documentScope),
        documentType: readTimingString(document?.documentType),
        documentId: readTimingString(document?.documentId)
    };
}

export function readTimingString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function readTimingBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

export function readTimingStringList(value: unknown): string | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strings = value
        .map((item) => readTimingString(item))
        .filter((item): item is string => item !== undefined);
    return strings.length > 0 ? strings.join(',') : undefined;
}

export function compactTimingDetails(details: RallarTimingDetails): RallarTimingDetails {
    return Object.fromEntries(
        Object.entries(details).filter(([, value]) => value !== undefined)
    ) as RallarTimingDetails;
}
