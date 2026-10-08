const SCOPE_ROLE = 'scope';

const PARALLEL_GROUPS_ROLE = 'parallel-groups';

const PARALLEL_GROUP_ROLE = 'parallel-group';

const stateGroupPathPattern = new RegExp(
    String.raw`^/api/state/apps/([^/]+)/workspaces/([^/]+)/groups` +
        String.raw`(?:/(?!requests(?:/|$))([^/]+))?(?=/|$)`
);

const identityFieldNames = new Set(['applicationId', 'workspaceId', 'groupId', 'roomId']);

export function validateHetznerRunManifestScope(value, expectedGroupRef) {
    return validateManifestScopeValue(value, expectedGroupRef, {
        location: '$',
        role: SCOPE_ROLE
    });
}

export function toEffectiveHetznerRunManifestScope(value, sourceGroupRef, effectiveGroupRef) {
    return toEffectiveScopeValue(
        value,
        { sourceGroupRef, effectiveGroupRef },
        { key: '', role: SCOPE_ROLE }
    );
}

function decodePathSegment(value, location, issues) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        issues.push(
            `${location} contains an invalid URI-encoded identity segment ${JSON.stringify(value)}`
        );
        return value;
    }
}

function validateEmbeddedPathScope(value, expectedGroupRef, location) {
    if (!value.startsWith('/api/state/apps/')) {
        return [];
    }

    const issues = [];
    const match = value.match(stateGroupPathPattern);
    if (!match) {
        return [`${location} has an unrecognized state group path ${JSON.stringify(value)}`];
    }

    const applicationId = decodePathSegment(match[1], location, issues);
    const workspaceId = decodePathSegment(match[2], location, issues);
    const groupId = match[3] === undefined ? undefined : decodePathSegment(match[3], location, issues);
    if (applicationId !== expectedGroupRef.applicationId) {
        issues.push(
            `${location} contains application ${JSON.stringify(applicationId)}; ` +
                `expected ${JSON.stringify(expectedGroupRef.applicationId)}`
        );
    }
    if (workspaceId !== expectedGroupRef.workspaceId) {
        issues.push(
            `${location} contains workspace ${JSON.stringify(workspaceId)}; ` +
                `expected ${JSON.stringify(expectedGroupRef.workspaceId)}`
        );
    }
    if (groupId !== undefined && groupId !== expectedGroupRef.groupId) {
        issues.push(
            `${location} contains group ${JSON.stringify(groupId)}; ` +
                `expected ${JSON.stringify(expectedGroupRef.groupId)}`
        );
    }
    return issues;
}

function validateEmbeddedRequestScope(value, expectedGroupRef, location) {
    const request = toScopedRequestIdentity(value);
    if (!request) {
        return [];
    }

    const scope = request.segments;
    const expectedScope = [
        expectedGroupRef.applicationId,
        expectedGroupRef.workspaceId,
        expectedGroupRef.groupId
    ];
    if (scope.length < expectedScope.length) {
        return [`${location} has an incomplete scoped request identity ${JSON.stringify(value)}`];
    }

    return expectedScope.flatMap((expected, index) =>
        scope[index] === expected
            ? []
            : [
                `${location} contains scoped request identity ${JSON.stringify(value)}; ` +
                `expected ${JSON.stringify(expectedGroupRef)}`
            ]
    );
}

function validateEmbeddedScope(input) {
    const { value, key, expectedGroupRef, location } = input;
    if (typeof value !== 'string') {
        return [];
    }
    if (key === 'path') {
        return validateEmbeddedPathScope(value, expectedGroupRef, location);
    }
    if (key === 'requestId' || key.toLowerCase() === 'idempotency-key') {
        return validateEmbeddedRequestScope(value, expectedGroupRef, location);
    }
    return [];
}

function validateManifestScopeValue(value, expectedGroupRef, traversal) {
    const issues = [];

    if (Array.isArray(value)) {
        const itemRole = traversal.role === PARALLEL_GROUPS_ROLE ? PARALLEL_GROUP_ROLE : SCOPE_ROLE;
        value.forEach((entry, index) => {
            issues.push(
                ...validateManifestScopeValue(entry, expectedGroupRef, {
                    location: `${traversal.location}[${index}]`,
                    role: itemRole
                })
            );
        });
        return issues;
    }

    if (!value || typeof value !== 'object') {
        return issues;
    }

    for (const [key, entry] of Object.entries(value)) {
        const entryLocation = `${traversal.location}.${key}`;
        const isParallelGroupLabel = traversal.role === PARALLEL_GROUP_ROLE && key === 'groupId';
        issues.push(
            ...validateEmbeddedScope({
                value: entry,
                key,
                expectedGroupRef,
                location: entryLocation
            })
        );
        if (!isParallelGroupLabel && identityFieldNames.has(key) && typeof entry === 'string') {
            const expected = key === 'applicationId'
                ? expectedGroupRef.applicationId
                : key === 'workspaceId'
                ? expectedGroupRef.workspaceId
                : expectedGroupRef.groupId;
            if (entry !== expected) {
                issues.push(
                    `${entryLocation} is ${JSON.stringify(entry)}; expected ${JSON.stringify(expected)}`
                );
            }
        }
        issues.push(
            ...validateManifestScopeValue(entry, expectedGroupRef, {
                location: entryLocation,
                role: value.kind === 'parallel' && key === 'groups' ? PARALLEL_GROUPS_ROLE : SCOPE_ROLE
            })
        );
    }

    return issues;
}

function toScopedRequestIdentity(value) {
    const marker = value.includes(':ensure-group:')
        ? ':ensure-group:'
        : value.includes(':ensure-member:')
        ? ':ensure-member:'
        : undefined;
    if (!marker) {
        return undefined;
    }
    const scopeStart = value.indexOf(marker) + marker.length;
    return { prefix: value.slice(0, scopeStart), segments: value.slice(scopeStart).split(':') };
}

function toEmbeddedScope(value, groupRefs, key) {
    const { sourceGroupRef, effectiveGroupRef } = groupRefs;
    if (key === 'path') {
        const match = value.match(stateGroupPathPattern);
        if (!match) {
            return value;
        }
        const effectivePrefix = `/api/state/apps/${encodeURIComponent(effectiveGroupRef.applicationId)}` +
            `/workspaces/${encodeURIComponent(effectiveGroupRef.workspaceId)}/groups`;
        const groupSegment = match[3] === undefined ? '' : `/${encodeURIComponent(effectiveGroupRef.groupId)}`;
        return `${effectivePrefix}${groupSegment}${value.slice(match[0].length)}`;
    }
    if (key !== 'requestId' && key.toLowerCase() !== 'idempotency-key') {
        return value;
    }
    const request = toScopedRequestIdentity(value);
    if (!request) {
        return value;
    }
    const sourceIdentity = [sourceGroupRef.applicationId, sourceGroupRef.workspaceId, sourceGroupRef.groupId];
    if (!sourceIdentity.every((segment, index) => request.segments[index] === segment)) {
        return value;
    }
    const segments = [
        effectiveGroupRef.applicationId,
        effectiveGroupRef.workspaceId,
        effectiveGroupRef.groupId,
        ...request.segments.slice(3)
    ];
    return `${request.prefix}${segments.join(':')}`;
}

function toEffectiveScopeValue(value, groupRefs, traversal) {
    const { sourceGroupRef, effectiveGroupRef } = groupRefs;
    if (Array.isArray(value)) {
        const itemRole = traversal.role === PARALLEL_GROUPS_ROLE ? PARALLEL_GROUP_ROLE : SCOPE_ROLE;
        return value.map((entry) =>
            toEffectiveScopeValue(entry, groupRefs, {
                key: '',
                role: itemRole
            })
        );
    }

    if (!value || typeof value !== 'object') {
        if (typeof value !== 'string') {
            return value;
        }
        return toEmbeddedScope(value, groupRefs, traversal.key);
    }

    return Object.fromEntries(
        Object.entries(value).map(([entryKey, entry]) => {
            const isParallelGroupLabel = traversal.role === PARALLEL_GROUP_ROLE && entryKey === 'groupId';
            if (isParallelGroupLabel) {
                return [entryKey, entry];
            }
            if (entryKey === 'applicationId' && entry === sourceGroupRef.applicationId) {
                return [entryKey, effectiveGroupRef.applicationId];
            }
            if (entryKey === 'workspaceId' && entry === sourceGroupRef.workspaceId) {
                return [entryKey, effectiveGroupRef.workspaceId];
            }
            if ((entryKey === 'groupId' || entryKey === 'roomId') && entry === sourceGroupRef.groupId) {
                return [entryKey, effectiveGroupRef.groupId];
            }
            return [
                entryKey,
                toEffectiveScopeValue(entry, groupRefs, {
                    key: entryKey,
                    role: value.kind === 'parallel' && entryKey === 'groups' ? PARALLEL_GROUPS_ROLE : SCOPE_ROLE
                })
            ];
        })
    );
}
