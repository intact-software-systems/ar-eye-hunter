import type { ControlFleetReportBundle } from '@shared-test/rallar-bb-test/fleet-report.ts';

export type FleetArtifactDownload = Readonly<{
    filename: string;
    content: string;
    mediaType: 'application/json';
}>;

export function createFleetArtifactDownload(
    bundle: ControlFleetReportBundle
): FleetArtifactDownload {
    return {
        filename: `${safeFilenameSegment(bundle.distributedRunId)}-fleet-report-bundle.json`,
        content: `${JSON.stringify(bundle, null, 2)}\n`,
        mediaType: 'application/json'
    };
}

export function downloadFleetArtifactEnvelope(
    bundle: ControlFleetReportBundle
): void {
    if (typeof document === 'undefined') {
        return;
    }
    const download = createFleetArtifactDownload(bundle);
    const href = URL.createObjectURL(
        new Blob(
            [download.content],
            { type: download.mediaType }
        )
    );
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = download.filename;
    anchor.click();
    URL.revokeObjectURL(href);
}

const MAX_FILENAME_SEGMENT_LENGTH = 120;
const UNSAFE_FILENAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f/\\<>:"|?*\u2028-\u202e\u2066-\u2069]/gu;

function safeFilenameSegment(value: string): string {
    const normalized = Array.from(value, (character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 0xd800 && codePoint <= 0xdfff ? '-' : character;
    }).join('')
        .replace(UNSAFE_FILENAME_CHARACTERS, '-')
        .replace(/\.{2,}/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[.\s-]+|[.\s-]+$/g, '')
        .slice(0, MAX_FILENAME_SEGMENT_LENGTH)
        .replace(/[.\s-]+$/g, '');
    return normalized || 'distributed-run';
}
