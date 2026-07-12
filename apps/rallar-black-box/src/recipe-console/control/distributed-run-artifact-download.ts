export type DistributedRunArtifactDownload = Readonly<{
    filename: string;
    content: string;
    mediaType: 'application/json';
}>;

export function createDistributedRunArtifactDownload(
    value: unknown,
    distributedRunId: string,
): DistributedRunArtifactDownload {
    return {
        filename: `${safeFilenameSegment(distributedRunId)}-artifact.json`,
        content: `${JSON.stringify(value, null, 2)}\n`,
        mediaType: 'application/json',
    };
}

const MAX_FILENAME_SEGMENT_LENGTH = 120;
const UNSAFE_FILENAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f/\\<>:"|?*\u2028-\u202e\u2066-\u2069]/gu;

function safeFilenameSegment(value: string): string {
    const normalized = replaceLoneSurrogates(value)
        .replace(UNSAFE_FILENAME_CHARACTERS, '-')
        .replace(/\.{2,}/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[.\s-]+|[.\s-]+$/g, '')
        .slice(0, MAX_FILENAME_SEGMENT_LENGTH)
        .replace(/[.\s-]+$/g, '');
    return normalized || 'distributed-run';
}

function replaceLoneSurrogates(value: string): string {
    return Array.from(value, character => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 0xd800 && codePoint <= 0xdfff
            ? '-'
            : character;
    }).join('');
}

export function downloadDistributedRunArtifact(
    value: unknown,
    distributedRunId: string,
): void {
    const download = createDistributedRunArtifactDownload(
        value,
        distributedRunId,
    );
    const url = URL.createObjectURL(new Blob(
        [download.content],
        { type: download.mediaType },
    ));
    const link = document.createElement('a');
    link.href = url;
    link.download = download.filename;
    link.click();
    URL.revokeObjectURL(url);
}
