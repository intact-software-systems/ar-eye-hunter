/** Search text compares trimmed and lower-cased in the en-US locale; absent text is empty. */
export function toNormalizedEvidenceText(value: string | undefined): string {
    return value?.trim().toLocaleLowerCase('en-US') ?? '';
}
