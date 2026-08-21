import { rtcBaselineIssue, type RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import { isRtcBaselineConfinedArtifactPath } from '../contracts/rtc-baseline-validation.ts';
import type { RtcBaselineFilePort } from './rtc-baseline-file-port.ts';

export interface RtcBaselineConfinedPath {
    readonly rootPath: string;
    baselinePath(baselineId: string): string;
    isConfined(baselineId: string, relativePath: string): boolean;
    inspect(baselineId: string, relativePath: string): Promise<RtcBaselineResult<string>>;
}

export function rtcBaselineUnconfinedPathFailure(): RtcBaselineResult<never> {
    return {
        ok: false,
        issues: [
            rtcBaselineIssue(
                '$.path',
                'unconfined-path',
                'Artifact path must remain beneath the baseline directory.'
            )
        ]
    };
}

export function rtcBaselineSymlinkPathFailure(): RtcBaselineResult<never> {
    return {
        ok: false,
        issues: [
            rtcBaselineIssue(
                '$.path',
                'symlink-component',
                'Artifact paths may not contain symlink components.'
            )
        ]
    };
}

export function createRtcBaselineConfinedPath(input: {
    readonly rootPath: string;
    readonly filePort: RtcBaselineFilePort;
}): RtcBaselineConfinedPath {
    const { rootPath, filePort } = input;
    const baselinePath = (baselineId: string) => `${rootPath}/${baselineId}`;

    async function inspect(baselineId: string, relativePath: string) {
        if (!isRtcBaselineConfinedArtifactPath(baselineId, relativePath)) {
            return rtcBaselineUnconfinedPathFailure();
        }
        const components = [rootPath, baselinePath(baselineId)];
        let current = baselinePath(baselineId);
        for (const component of relativePath.split('/')) {
            current = `${current}/${component}`;
            components.push(current);
        }
        try {
            for (const component of components) {
                if ((await filePort.inspectPath(component))?.kind === 'symlink') {
                    return rtcBaselineSymlinkPathFailure();
                }
            }
            return { ok: true as const, value: current };
        }
        catch (error) {
            return {
                ok: false as const,
                issues: [
                    rtcBaselineIssue('$.path', 'inspect-failed', String(error).replace(/^Error: /, ''))
                ]
            };
        }
    }

    return {
        rootPath,
        baselinePath,
        isConfined: isRtcBaselineConfinedArtifactPath,
        inspect
    };
}
