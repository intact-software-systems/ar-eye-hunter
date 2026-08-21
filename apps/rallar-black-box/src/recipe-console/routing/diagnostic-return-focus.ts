const claimedDocuments = new WeakSet<Document>();

export function shouldRestoreDiagnosticReturnFocus(
    referrer: string,
    currentHref: string
): boolean {
    try {
        const source = new URL(referrer);
        const current = new URL(currentHref);
        return source.origin === current.origin &&
            source.pathname === current.pathname &&
            hasSingleValue(source.searchParams, 'experience', 'legacy') &&
            hasSingleValue(
                source.searchParams,
                'diagnosticContext',
                '1'
            ) &&
            hasSingleValue(
                current.searchParams,
                'experience',
                'recipe-console'
            ) &&
            hasSingleValue(current.searchParams, 'v', '1');
    }
    catch {
        return false;
    }
}

export function claimDiagnosticReturnFocus(
    ownerDocument: Document,
    currentHref: string
): boolean {
    if (
        claimedDocuments.has(ownerDocument) ||
        !shouldRestoreDiagnosticReturnFocus(
            ownerDocument.referrer,
            currentHref
        )
    ) {
        return false;
    }
    claimedDocuments.add(ownerDocument);
    return true;
}

function hasSingleValue(
    params: URLSearchParams,
    field: string,
    expected: string
): boolean {
    const values = params.getAll(field);
    return values.length === 1 && values[0] === expected;
}
