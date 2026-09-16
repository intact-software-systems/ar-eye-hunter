import type { DistributedRunAnalysisGroup } from '../distributed-artifact-analysis.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    decodeBoolean,
    decodeNumber,
    decodeText,
    decodeTexts
} from './decode-artifact-json-values.ts';
import {
    decodeDistributedRunTimingRecord,
    type DistributedRunTimingRecord
} from './decode-distributed-run-stream-summary.ts';

/** What analysis reads from fleet-report.json; every field is absent when the report does not record it. */
export interface DistributedRunFleetReportEvidence {
    readonly ok?: boolean;
    readonly agents?: number;
    readonly passRate?: number;
    readonly failureGroups?: number;
    readonly failedAgents?: number;
    readonly missingAgents?: number;
    readonly staleAgents?: number;
    readonly flakyAgents?: number;
    readonly commandTiming?: DistributedRunTimingRecord;
    readonly runP50Ms?: number;
    readonly group?: DistributedRunAnalysisGroup;
    /** The first entry of failureSignatures, when that entry is a JSON object. */
    readonly firstFailureSignature?: DistributedRunFleetFailureSignature;
}

/** A fleet failure signature; each text is absent when the signature does not record it. */
export interface DistributedRunFleetFailureSignature {
    readonly category?: string;
    readonly transport?: string;
    readonly title?: string;
    readonly normalizedMessage?: string;
    readonly likelyCause?: string;
    readonly nextAction?: string;
    readonly affectedAgents: readonly string[];
    readonly affectedRegions: readonly string[];
    readonly commandId?: string;
    readonly recipeId?: string;
}

/** The first failures.json entry; each field is absent when the entry does not record it. */
export interface DistributedRunBundledFailure {
    readonly code?: string;
    readonly message?: string;
    readonly errorMessage?: string;
    readonly agentId?: string;
    readonly commandId?: string;
}

/** Absent when the report is not a JSON object. */
export function decodeDistributedRunFleetReportEvidence(value: unknown): DistributedRunFleetReportEvidence | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }
    const summary = isJsonRecordValue(value.summary) ? value.summary : undefined;
    const timing = isJsonRecordValue(value.timing) ? value.timing : undefined;
    const runTiming = isJsonRecordValue(timing?.run) ? timing.run : undefined;
    const signatures = Array.isArray(value.failureSignatures) ? value.failureSignatures : [];
    return {
        ok: decodeBoolean(value.ok),
        agents: decodeNumber(summary?.agents),
        passRate: decodeNumber(summary?.passRate),
        failureGroups: decodeNumber(summary?.failureGroups),
        failedAgents: decodeNumber(summary?.failed),
        missingAgents: decodeNumber(summary?.missing),
        staleAgents: decodeNumber(summary?.stale),
        flakyAgents: decodeNumber(summary?.flaky),
        commandTiming: decodeDistributedRunTimingRecord(timing?.commands),
        runP50Ms: decodeNumber(runTiming?.p50Ms),
        group: decodeAnalysisGroup(value.group),
        firstFailureSignature: decodeFleetFailureSignature(signatures[0])
    };
}

/** Absent when failures.json lists no failures or its first failure is not a JSON object. */
export function decodeBundledFailure(value: unknown): DistributedRunBundledFailure | undefined {
    const failure = isJsonRecordValue(value) && Array.isArray(value.failures) ? value.failures[0] : undefined;
    if (!isJsonRecordValue(failure)) {
        return undefined;
    }
    const error = isJsonRecordValue(failure.error) ? failure.error : undefined;
    return {
        code: decodeText(error?.code),
        message: decodeText(failure.message),
        errorMessage: decodeText(error?.message),
        agentId: decodeText(failure.agentId),
        commandId: decodeText(failure.commandId)
    };
}

/** Absent when the value is not a JSON object with any field. */
export function decodeAnalysisGroup(value: unknown): DistributedRunAnalysisGroup | undefined {
    if (!isJsonRecordValue(value) || Object.keys(value).length === 0) {
        return undefined;
    }
    return {
        applicationId: decodeText(value.applicationId),
        workspaceId: decodeText(value.workspaceId),
        groupId: decodeText(value.groupId)
    };
}

function decodeFleetFailureSignature(value: unknown): DistributedRunFleetFailureSignature | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }
    return {
        category: decodeText(value.category),
        transport: decodeText(value.transport),
        title: decodeText(value.title),
        normalizedMessage: decodeText(value.normalizedMessage),
        likelyCause: decodeText(value.likelyCause),
        nextAction: decodeText(value.nextAction),
        affectedAgents: decodeTexts(value.affectedAgents),
        affectedRegions: decodeTexts(value.affectedRegions),
        commandId: decodeText(value.commandId),
        recipeId: decodeText(value.recipeId)
    };
}
