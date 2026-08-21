export type AnalyzeRetainedExport = Readonly<{
    generation: number;
    blob: Blob;
    filename: string;
}>;

export type AnalyzeExportBlobRetention = Readonly<{
    stage(candidate: AnalyzeRetainedExport): void;
    commit(generation: number): boolean;
    reject(generation: number): void;
    current(): AnalyzeRetainedExport | undefined;
    clear(): void;
}>;

export function createAnalyzeExportBlobRetention(): AnalyzeExportBlobRetention {
    let candidate: AnalyzeRetainedExport | undefined;
    let accepted: AnalyzeRetainedExport | undefined;

    return {
        stage(next) {
            candidate = Object.freeze({ ...next });
        },
        commit(generation) {
            if (candidate?.generation !== generation) {
                return false;
            }
            accepted = candidate;
            candidate = undefined;
            return true;
        },
        reject(generation) {
            if (candidate?.generation === generation) {
                candidate = undefined;
            }
        },
        current() {
            return accepted;
        },
        clear() {
            candidate = undefined;
            accepted = undefined;
        }
    };
}
