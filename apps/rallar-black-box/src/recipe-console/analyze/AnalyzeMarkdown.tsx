import { useState } from 'react';
import { PROJECTION_OMISSION_MESSAGE } from './analyze-projection-bounds.ts';
import type { AnalyzeArtifactProjection } from './analyze-worker-projection-contract.ts';
import styles from './AnalyzeEvidence.module.css';

type MarkdownDocument = Readonly<{
    id: string;
    label: string;
    value: string;
}>;

export function AnalyzeMarkdown({
    model
}: Readonly<{ model: AnalyzeArtifactProjection; }>) {
    const [feedback, setFeedback] = useState<string>();
    const documents = markdownDocuments(model);

    async function copy(document: MarkdownDocument): Promise<void> {
        try {
            if (!navigator.clipboard) {
                throw new Error('Clipboard access is unavailable.');
            }
            await navigator.clipboard.writeText(document.value);
            setFeedback(`${document.label} copied.`);
        }
        catch (error) {
            setFeedback(error instanceof Error ? error.message : String(error));
        }
    }

    return (
        <section className={styles.panel} data-analyze-section="markdown">
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>Issue-ready output</p>
                    <h2>Copy analysis without raw JSON</h2>
                </div>
                <span>{documents.length} documents</span>
            </header>
            <div className={styles.markdownActions} aria-label="Artifact Markdown documents">
                {documents.map((document) => (
                    <button
                        key={document.id}
                        type="button"
                        onClick={() => void copy(document)}
                    >
                        Copy {document.label.toLowerCase()}
                    </button>
                ))}
            </div>
            <details className={styles.markdownPreview}>
                <summary>Preview issue Markdown</summary>
                <pre>{model.issueMarkdown}</pre>
            </details>
            <p className={styles.copyFeedback} role="status" aria-live="polite">
                {feedback ?? 'Markdown is rendered as text and copied only on request.'}
            </p>
        </section>
    );
}

function markdownDocuments(model: AnalyzeArtifactProjection): readonly MarkdownDocument[] {
    const analysis = model.analysis;
    const summary = analysis.detail === 'full'
        ? analysis.summaryMarkdown
        : PROJECTION_OMISSION_MESSAGE;
    const performanceMarkdown = analysis.detail === 'full'
        ? analysis.performanceMarkdown
        : undefined;
    return [
        { id: 'issue', label: 'Issue Markdown', value: model.issueMarkdown },
        { id: 'summary', label: 'Summary', value: summary },
        !analysis.ok && analysis.fixProposalMarkdown
            ? { id: 'fix', label: 'Fix proposal', value: analysis.fixProposalMarkdown }
            : undefined,
        performanceMarkdown
            ? { id: 'performance', label: 'Performance', value: performanceMarkdown }
            : undefined
    ].filter((document): document is MarkdownDocument => document !== undefined);
}
