export function isReadRequest(request: Request): boolean {
    return request.method === 'GET' || request.method === 'HEAD';
}

export function toPathParameters(pathname: string, pattern: RegExp): readonly string[] | undefined {
    const match = pattern.exec(pathname);
    return match ? match.slice(1).map((segment) => decodeURIComponent(segment)) : undefined;
}
