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

/** What analysis reads from fleet-report.json. */
export interface DistributedRunFleetReportEvidence {
    /** Absent when the report records no boolean verdict. */
    readonly ok?: boolean;
    /** Absent when the report summary counts no agents. */
    readonly agents?: number;
    /** Absent when the report summary records no pass rate. */
    readonly passRate?: number;
    /** Absent when the report summary counts no failure groups. */
    readonly failureGroups?: number;
    /** Absent when the report summary counts no failed agents. */
    readonly failedAgents?: number;
    /** Absent when the report summary counts no missing agents. */
    readonly missingAgents?: number;
    /** Absent when the report summary counts no stale agents. */
    readonly staleAgents?: number;
    /** Absent when the report summary counts no flaky agents. */
    readonly flakyAgents?: number;
    /** Absent when the report records no command timing object. */
    readonly commandTiming?: DistributedRunTimingRecord;
    /** Absent when the report's run timing records no median. */
    readonly runP50Ms?: number;
    /** Absent when the report names no group. */
    readonly group?: DistributedRunAnalysisGroup;
    /** The first entry of failureSignatures; absent when there is none or it is not a JSON object. */
    readonly firstFailureSignature?: DistributedRunFleetFailureSignature;
}

/** A fleet failure signature. */
export interface DistributedRunFleetFailureSignature {
    /** Absent when the signature names no category. */
    readonly category?: string;
    /** Absent when the signature names no transport. */
    readonly transport?: string;
    /** Absent when the signature carries no title. */
    readonly title?: string;
    /** Absent when the signature carries no normalized message. */
    readonly normalizedMessage?: string;
    /** Absent when the signature names no likely cause. */
    readonly likelyCause?: string;
    /** Absent when the signature names no next action. */
    readonly nextAction?: string;
    readonly affectedAgents: readonly string[];
    readonly affectedRegions: readonly string[];
    /** Absent when the signature names no command. */
    readonly commandId?: string;
    /** Absent when the signature names no recipe. */
    readonly recipeId?: string;
}

/** The first failures.json entry. */
export interface DistributedRunBundledFailure {
    /** Absent when the entry's error records no code. */
    readonly code?: string;
    /** Absent when the entry carries no top-level message. */
    readonly message?: string;
    /** Absent when the entry's error records no message. */
    readonly errorMessage?: string;
    /** Absent when the entry names no agent. */
    readonly agentId?: string;
    /** Absent when the entry names no command. */
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
