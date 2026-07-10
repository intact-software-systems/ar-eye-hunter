import type { RunVerdictView } from '@shared-test/rallar-bb-test/mod.ts';
import {
    boundedText,
    finiteNumber,
    MAX_ANALYSIS_ROWS,
    MAX_METADATA_BYTES,
    MAX_NESTED_EVIDENCE_ROWS,
    MAX_SUMMARY_BYTES,
    projectOpaqueIdentifier,
} from './analyze-projection-bounds.ts';

export function projectAnalyzeVerdict(verdict: RunVerdictView): RunVerdictView {
    return {
        verdict: verdict.verdict,
        tone: verdict.tone,
        title: boundedText(verdict.title, MAX_SUMMARY_BYTES),
        summary: boundedText(verdict.summary),
        ...(verdict.runId ? { runId: projectOpaqueIdentifier(verdict.runId) } : {}),
        ...(verdict.state
            ? { state: boundedText(verdict.state, MAX_METADATA_BYTES) }
            : {}),
        ...(verdict.recipeLabel
            ? { recipeLabel: boundedText(verdict.recipeLabel, MAX_METADATA_BYTES) }
            : {}),
        ...(verdict.profileLabel
            ? { profileLabel: boundedText(verdict.profileLabel, MAX_METADATA_BYTES) }
            : {}),
        ...(verdict.targetCount !== undefined
            ? { targetCount: finiteNumber(verdict.targetCount) }
            : {}),
        ...(verdict.durationMs !== undefined
            ? { durationMs: finiteNumber(verdict.durationMs) }
            : {}),
        artifactStatus: verdict.artifactStatus,
        artifactMessage: boundedText(verdict.artifactMessage, MAX_SUMMARY_BYTES),
        ...(verdict.refreshedAtEpochMs !== undefined
            ? { refreshedAtEpochMs: finiteNumber(verdict.refreshedAtEpochMs) }
            : {}),
        ...(verdict.likelyCause
            ? { likelyCause: boundedText(verdict.likelyCause) }
            : {}),
        ...(verdict.nextAction
            ? { nextAction: boundedText(verdict.nextAction) }
            : {}),
        primaryEvidence: verdict.primaryEvidence.slice(0, MAX_ANALYSIS_ROWS).map(
            row => ({
                label: boundedText(row.label, MAX_METADATA_BYTES),
                value: boundedText(row.value, MAX_SUMMARY_BYTES),
                tone: row.tone,
                ...(row.detail ? { detail: boundedText(row.detail) } : {}),
            }),
        ),
        successSignals: verdict.successSignals.slice(0, MAX_ANALYSIS_ROWS)
            .map(value => boundedText(value, MAX_SUMMARY_BYTES)),
        warningSignals: verdict.warningSignals.slice(0, MAX_ANALYSIS_ROWS)
            .map(value => boundedText(value, MAX_SUMMARY_BYTES)),
        causalTrail: verdict.causalTrail.slice(0, MAX_ANALYSIS_ROWS).map(row => ({
            kind: row.kind,
            label: boundedText(row.label, MAX_METADATA_BYTES),
            detail: boundedText(row.detail, MAX_SUMMARY_BYTES),
            tone: row.tone,
            ...(row.targetKind ? { targetKind: row.targetKind } : {}),
            ...(row.targetId
                ? { targetId: projectOpaqueIdentifier(row.targetId) }
                : {}),
            ...(row.actionLabel
                ? { actionLabel: boundedText(row.actionLabel, MAX_METADATA_BYTES) }
                : {}),
            ...(row.agentId
                ? { agentId: projectOpaqueIdentifier(row.agentId) }
                : {}),
            ...(row.recipeId
                ? { recipeId: projectOpaqueIdentifier(row.recipeId) }
                : {}),
            ...(row.commandId
                ? { commandId: projectOpaqueIdentifier(row.commandId) }
                : {}),
            ...(row.atEpochMs !== undefined
                ? { atEpochMs: finiteNumber(row.atEpochMs) }
                : {}),
            evidence: row.evidence.slice(0, MAX_NESTED_EVIDENCE_ROWS)
                .map(value => boundedText(value, MAX_METADATA_BYTES)),
        })),
    };
}
