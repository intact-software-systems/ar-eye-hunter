export function toLowerCaseRallarServerHeaders(
    headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}
