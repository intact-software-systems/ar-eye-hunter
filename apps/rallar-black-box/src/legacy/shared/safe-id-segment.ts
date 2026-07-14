export function safeIdSegment(value: string): string {
    return (
        value
            .trim()
            .replace(/[^A-Za-z0-9_.:-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'value'
    );
}
