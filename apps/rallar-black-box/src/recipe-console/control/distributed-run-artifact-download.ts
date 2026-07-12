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
        filename: `${distributedRunId}-artifact.json`,
        content: `${JSON.stringify(value, null, 2)}\n`,
        mediaType: 'application/json',
    };
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
