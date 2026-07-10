import {
    type ComposeDistributedArtifactIssueMarkdownInput,
} from './distributed-artifact-evidence-contracts.ts';
import { boundedEvidenceLimit } from './distributed-artifact-evidence-utils.ts';

export function composeDistributedArtifactIssueMarkdown(
    input: ComposeDistributedArtifactIssueMarkdownInput,
): string {
    const sections: string[] = [
        `# Distributed run ${input.analysis.distributedRunId}`,
        `## Summary\n\n${withoutLeadingHeading(input.analysis.summaryMarkdown)}`,
    ];
    if (input.analysis.parseWarnings.length > 0) {
        sections.push([
            '## Artifact warnings',
            '',
            ...input.analysis.parseWarnings.map(warning =>
                `- **${warning.fileName}**${
                    warning.lineNumber === undefined
                        ? ''
                        : ` line ${warning.lineNumber}`
                }: ${warning.message}`
            ),
        ].join('\n'));
    }
    if (input.analysis.fixProposalMarkdown) {
        sections.push(
            `## Fix proposal\n\n${withoutLeadingHeading(input.analysis.fixProposalMarkdown)}`,
        );
    }
    if (input.analysis.performanceMarkdown) {
        sections.push(
            `## Performance\n\n${withoutLeadingHeading(input.analysis.performanceMarkdown)}`,
        );
    }

    const causalLimit = boundedEvidenceLimit(
        input.maxCausalTrailItems,
        5,
        20,
    );
    const causalTrail = input.analysis.spa?.verdict.causalTrail
        .slice(0, causalLimit) ?? [];
    const likelyRows = causalTrail.length > 0
        ? causalTrail.map(item => {
            const selectors = [item.agentId, item.recipeId, item.commandId]
                .filter(Boolean)
                .join(' / ');
            const evidence = item.evidence.length > 0
                ? ` Evidence: ${item.evidence.join(', ')}.`
                : '';
            return `- ${item.label}: ${item.detail}${
                selectors ? ` (${selectors})` : ''
            }.${evidence}`;
        })
        : (input.searchResult?.entries ?? input.index?.entries ?? [])
            .filter(entry =>
                entry.kind === 'failure' || entry.kind === 'diagnostic'
            )
            .slice(0, causalLimit)
            .map(entry =>
                `- ${entry.summary} (${entry.sourceFile}${
                    entry.atEpochMs === undefined ? '' : ` @ ${entry.atEpochMs}`
                }).`
            );
    if (likelyRows.length > 0) {
        sections.push([
            '## Likely causal trail',
            '',
            '_Likely, not proven; verify against the referenced evidence._',
            '',
            ...likelyRows,
        ].join('\n'));
    }

    const sourceEntries = (
        input.searchResult?.entries ?? input.index?.entries ?? []
    ).slice(0, boundedEvidenceLimit(input.maxSourceEvidenceItems, 8, 20));
    if (sourceEntries.length > 0) {
        sections.push([
            '## Source evidence',
            '',
            ...sourceEntries.map(entry => {
                const selectors = [
                    ...(entry.agentIds ?? []),
                    entry.recipeId,
                    entry.commandId,
                ].filter(Boolean).join(' / ');
                const time = entry.atEpochMs === undefined
                    ? ''
                    : ` @ ${entry.atEpochMs}`;
                return `- **${entry.sourceFile}** · ${entry.kind}${time}${
                    selectors ? ` · ${selectors}` : ''
                }: ${entry.summary}`;
            }),
        ].join('\n'));
    }
    return withoutRawHtml(sections.join('\n\n').trim());
}

function withoutRawHtml(markdown: string): string {
    return markdown.replaceAll('<', '‹').replaceAll('>', '›');
}

function withoutLeadingHeading(markdown: string): string {
    const lines = markdown.trim().split(/\r?\n/);
    if (lines[0]?.startsWith('# ')) lines.shift();
    while (lines[0]?.trim().length === 0) lines.shift();
    return lines.join('\n');
}
