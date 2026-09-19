import type { DistributedRunAnalysis } from '../distributed-artifact-analysis.ts';
import type { DistributedArtifactEvidenceEntry } from '../distributed-artifact-evidence-contracts.ts';
import { resolveEvidenceLimit } from './distributed-artifact-evidence-bounds.ts';

/** How many causal trail items and source evidence rows an issue quotes; each is clamped to its maximum. */
export interface DistributedArtifactIssueMarkdownLimits {
    readonly causalTrailItems: number;
    readonly sourceEvidenceItems: number;
}

export interface ToDistributedArtifactIssueMarkdownInput {
    readonly analysis: DistributedRunAnalysis;
    /** The evidence rows the issue quotes, in the order to quote them: a search result's rows or an index's rows. */
    readonly evidence: readonly DistributedArtifactEvidenceEntry[];
    readonly limits: DistributedArtifactIssueMarkdownLimits;
}

export const DEFAULT_DISTRIBUTED_ARTIFACT_ISSUE_MARKDOWN_LIMITS: DistributedArtifactIssueMarkdownLimits = {
    causalTrailItems: 5,
    sourceEvidenceItems: 8
};

const MAX_ISSUE_MARKDOWN_ITEMS = 20;

/** Raw HTML in any recorded text is defused, since the issue is pasted where Markdown renders. */
export function toDistributedArtifactIssueMarkdown(input: ToDistributedArtifactIssueMarkdownInput): string {
    const { analysis } = input;
    const sections = [
        `# Distributed run ${analysis.distributedRunId}`,
        `## Summary\n\n${toMarkdownWithoutLeadingHeading(analysis.summaryMarkdown)}`,
        toArtifactWarningsSection(analysis),
        analysis.ok ? undefined : `## Fix proposal\n\n${toMarkdownWithoutLeadingHeading(analysis.fixProposalMarkdown)}`,
        analysis.performanceMarkdown
            ? `## Performance\n\n${toMarkdownWithoutLeadingHeading(analysis.performanceMarkdown)}`
            : undefined,
        toLikelyCausalTrailSection(input),
        toSourceEvidenceSection(input)
    ];
    return toMarkdownWithoutRawHtml(sections.filter((section) => section !== undefined).join('\n\n').trim());
}

function toArtifactWarningsSection(analysis: DistributedRunAnalysis): string | undefined {
    if (analysis.parseWarnings.length === 0) {
        return undefined;
    }
    return [
        '## Artifact warnings',
        '',
        ...analysis.parseWarnings.map((warning) =>
            `- **${warning.fileName}**${
                warning.lineNumber === undefined ? '' : ` line ${warning.lineNumber}`
            }: ${warning.message}`
        )
    ].join('\n');
}

/** The analysis verdict's causal trail when it has one, else the quoted failure and diagnostic rows. */
function toLikelyCausalTrailSection(input: ToDistributedArtifactIssueMarkdownInput): string | undefined {
    const limit = resolveEvidenceLimit(
        input.limits.causalTrailItems,
        DEFAULT_DISTRIBUTED_ARTIFACT_ISSUE_MARKDOWN_LIMITS.causalTrailItems,
        MAX_ISSUE_MARKDOWN_ITEMS
    );
    const causalTrail = input.analysis.spa?.verdict.causalTrail.slice(0, limit) ?? [];
    const rows = causalTrail.length > 0
        ? causalTrail.map((item) => {
            const selectors = [item.agentId, item.recipeId, item.commandId].filter(Boolean).join(' / ');
            const evidence = item.evidence.length > 0 ? ` Evidence: ${item.evidence.join(', ')}.` : '';
            return `- ${item.label}: ${item.detail}${selectors ? ` (${selectors})` : ''}.${evidence}`;
        })
        : input.evidence
            .filter((entry) => entry.kind === 'failure' || entry.kind === 'diagnostic')
            .slice(0, limit)
            .map((entry) => `- ${entry.summary} (${entry.sourceFile}${toEvidenceTimeText(entry)}).`);
    if (rows.length === 0) {
        return undefined;
    }
    return ['## Likely causal trail', '', '_Likely, not proven; verify against the referenced evidence._', '', ...rows]
        .join('\n');
}

function toSourceEvidenceSection(input: ToDistributedArtifactIssueMarkdownInput): string | undefined {
    const limit = resolveEvidenceLimit(
        input.limits.sourceEvidenceItems,
        DEFAULT_DISTRIBUTED_ARTIFACT_ISSUE_MARKDOWN_LIMITS.sourceEvidenceItems,
        MAX_ISSUE_MARKDOWN_ITEMS
    );
    const entries = input.evidence.slice(0, limit);
    if (entries.length === 0) {
        return undefined;
    }
    return [
        '## Source evidence',
        '',
        ...entries.map((entry) => {
            const selectors = [...(entry.agentIds ?? []), entry.recipeId, entry.commandId].filter(Boolean).join(' / ');
            return `- **${entry.sourceFile}** · ${entry.kind}${toEvidenceTimeText(entry)}${
                selectors ? ` · ${selectors}` : ''
            }: ${entry.summary}`;
        })
    ].join('\n');
}

function toEvidenceTimeText(entry: DistributedArtifactEvidenceEntry): string {
    return entry.atEpochMs === undefined ? '' : ` @ ${entry.atEpochMs}`;
}

function toMarkdownWithoutRawHtml(markdown: string): string {
    return markdown.replaceAll('<', '‹').replaceAll('>', '›');
}

function toMarkdownWithoutLeadingHeading(markdown: string): string {
    const lines = markdown.trim().split(/\r?\n/);
    if (lines[0]?.startsWith('# ')) {
        lines.shift();
    }
    while (lines[0]?.trim().length === 0) {
        lines.shift();
    }
    return lines.join('\n');
}
