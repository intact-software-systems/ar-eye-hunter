export const FULL_STACK_RTC_BUILD_TOOL_INPUT_COMMAND = [
    '--experimental-import-meta-resolve',
    '--import',
    'tsx',
    'packages/shared-test/black-box-runner/fixtures/rtc-production/read-full-stack-rtc-build-tool-inputs.ts'
] as const;

export function decodeFullStackRtcBuildToolInputs(raw: unknown): readonly string[] | null {
    if (
        !Array.isArray(raw) || raw.length === 0 ||
        raw.some((path) =>
            typeof path !== 'string' || !path.startsWith('node_modules/') || !/^[a-zA-Z0-9@._/-]+$/.test(path) ||
            path.split('/').includes('..')
        )
    ) {
        return null;
    }
    return [...new Set(raw as string[])].sort();
}
