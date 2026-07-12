export type ExecuteArtifactDownload = Readonly<{
    filename: string;
    content: string;
    mediaType: 'application/json';
}>;

export function createExecuteArtifactDownload(
    value: unknown,
    distributedRunId: string,
): ExecuteArtifactDownload {
    return {
        filename: `${distributedRunId}-artifact.json`,
        content: `${JSON.stringify(value, null, 2)}\n`,
        mediaType: 'application/json',
    };
}

export function downloadExecuteArtifact(value: unknown, distributedRunId: string): void {
    const download = createExecuteArtifactDownload(value, distributedRunId);
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
