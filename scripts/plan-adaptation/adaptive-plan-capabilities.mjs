export function validateAdaptivePlanCapabilities(capabilities) {
    const issues = [];
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
        return ['record.capabilities must contain at least one capability'];
    }
    for (const [index, capability] of capabilities.entries()) {
        if (!isRecord(capability)) {
            issues.push(`record.capabilities[${index}] must be an object`);
            continue;
        }
        const kind = capability.kind ?? 'code';
        if (!['code', 'guidance'].includes(kind)) {
            issues.push(`record.capabilities[${index}].kind must be code or guidance`);
            continue;
        }
        requireText(issues, capability.owner, `record.capabilities[${index}].owner`);
        validateCapabilityActivation(issues, capability, index);
        if (kind === 'guidance') {
            validateGuidanceCapability(issues, capability, index);
        }
        else {
            validateCodeCapability(issues, capability, index);
        }
    }
    validatePlannedCapabilityOwnership(issues, capabilities);
    validateCodeContractOwnership(issues, capabilities);
    validateGuidanceEntryOwnership(issues, capabilities);
    return issues;
}

function validatePlannedCapabilityOwnership(issues, capabilities) {
    for (const [leftIndex, leftCapability] of capabilities.entries()) {
        for (const rightCapability of capabilities.slice(leftIndex + 1)) {
            if (!isPlannedCapability(leftCapability) && !isPlannedCapability(rightCapability)) {
                continue;
            }
            const plannedCapability = isPlannedCapability(leftCapability)
                ? leftCapability
                : rightCapability;
            const otherCapability = plannedCapability === leftCapability ? rightCapability : leftCapability;
            for (const plannedRoot of topologyRoots(plannedCapability)) {
                for (const otherRoot of topologyRoots(otherCapability)) {
                    if (rootsOverlap(plannedRoot, otherRoot)) {
                        const otherState = isPlannedCapability(otherCapability) ? 'planned' : 'active';
                        issues.push(
                            `planned capability ${plannedCapability.owner} root ${plannedRoot} overlaps ` +
                                `${otherState} capability ${otherCapability.owner} root ${otherRoot}`
                        );
                    }
                }
            }
        }
    }
}

function topologyRoots(capability) {
    if (!isRecord(capability)) {
        return [];
    }
    if (capability.kind !== 'guidance') {
        return [capability.root, capability.testRoot].filter((root) => typeof root === 'string');
    }
    const guidanceRoots = [capability.contractTestRoot, capability.evaluationRoot];
    if (guidanceRole(capability) === 'skill') {
        guidanceRoots.push(capability.skillRoot);
    }
    return guidanceRoots.filter((root) => typeof root === 'string');
}

export function mutableCapabilityClaims(capability) {
    const roots = topologyRoots(capability).map((value) => ({ kind: 'root', value }));
    const paths = capability.kind === 'guidance'
        ? [guidanceEntry(capability), ...(capability.contractPaths ?? [])]
        : [
            capability.entry,
            capability.navigationMap,
            ...(capability.factContracts ?? []),
            ...(capability.contractPaths ?? [])
        ];
    return [...roots, ...paths.filter(Boolean).map((value) => ({ kind: 'path', value }))];
}

export function capabilityOwnsPath(repositoryPath, capability) {
    return mutableCapabilityClaims(capability).some((claim) =>
        claim.kind === 'root' ? isWithin(repositoryPath, claim.value) : repositoryPath === claim.value
    );
}

function rootsOverlap(left, right) {
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validateCapabilityActivation(issues, capability, index) {
    if (capability.activation === undefined) {
        return;
    }
    if (
        !isRecord(capability.activation) ||
        capability.activation.state !== 'planned' ||
        !hasExactKeys(capability.activation, ['state', 'slice'])
    ) {
        issues.push(
            `record.capabilities[${index}].activation must be omitted or exactly planned with one slice`
        );
        return;
    }
    if (
        typeof capability.activation.slice !== 'string' ||
        capability.activation.slice.trim() === ''
    ) {
        issues.push(
            `record.capabilities[${index}].activation.slice must be a non-empty string ` +
                'for planned capabilities'
        );
    }
}

export function isPlannedCapability(capability) {
    return capability?.activation?.state === 'planned';
}

function validateCodeCapability(issues, capability, index) {
    for (const field of ['root', 'entry', 'testRoot', 'focusedCommand']) {
        requireText(issues, capability[field], `record.capabilities[${index}].${field}`);
    }
    for (const field of ['root', 'entry', 'testRoot']) {
        if (!isSafeRepositoryPath(capability[field])) {
            issues.push(`record.capabilities[${index}].${field} must be a safe repository-relative path`);
        }
    }
    if (capability.navigationMap !== null && !isSafeRepositoryPath(capability.navigationMap)) {
        const name = `record.capabilities[${index}].navigationMap`;
        issues.push(`${name} must be null or a safe repository-relative path`);
    }
    if (
        capability.factContracts !== undefined &&
        (!Array.isArray(capability.factContracts) ||
            capability.factContracts.some((factContract) => !isSafeRepositoryPath(factContract)))
    ) {
        issues.push(
            `record.capabilities[${index}].factContracts must contain safe ` +
                'repository-relative paths'
        );
    }
    validateContractPaths({
        issues,
        contractPaths: capability.contractPaths,
        index,
        required: false
    });
    if (
        capability.controlFlowFamilies !== undefined &&
        (!Array.isArray(capability.controlFlowFamilies) ||
            capability.controlFlowFamilies.length === 0 ||
            capability.controlFlowFamilies.some(
                (family) => typeof family !== 'string' || family.trim() === ''
            ) ||
            new Set(capability.controlFlowFamilies).size !== capability.controlFlowFamilies.length)
    ) {
        issues.push(
            `record.capabilities[${index}].controlFlowFamilies must contain unique ` +
                'non-empty strings'
        );
    }
}

function validateGuidanceCapability(issues, capability, index) {
    for (const field of ['contractTestRoot', 'focusedCommand']) {
        requireText(issues, capability[field], `record.capabilities[${index}].${field}`);
    }
    if (capability.guidanceRole !== undefined && capability.guidanceRole !== 'router') {
        issues.push(`record.capabilities[${index}].guidanceRole must be router when present`);
    }
    const role = capability.guidanceRole === 'router' ? 'router' : 'skill';
    if (role === 'router') {
        validateGuidanceRouter(issues, capability, index);
    }
    else {
        validateGuidanceSkill(issues, capability, index);
    }
    if (!isSafeRepositoryPath(capability.contractTestRoot)) {
        issues.push(
            `record.capabilities[${index}].contractTestRoot must be a safe repository-relative path`
        );
    }
    if (
        capability.evaluationRoot !== undefined &&
        capability.evaluationRoot !== null &&
        !isSafeRepositoryPath(capability.evaluationRoot)
    ) {
        issues.push(
            `record.capabilities[${index}].evaluationRoot must be null or a safe ` +
                'repository-relative path'
        );
    }
    validateContractPaths({
        issues,
        contractPaths: capability.contractPaths,
        index,
        required: true
    });
}

function validateGuidanceSkill(issues, capability, index) {
    for (const field of ['skillRoot', 'skillEntry']) {
        requireText(issues, capability[field], `record.capabilities[${index}].${field}`);
        if (!isSafeRepositoryPath(capability[field])) {
            issues.push(`record.capabilities[${index}].${field} must be a safe repository-relative path`);
        }
    }
    if (capability.skillEntry !== `${capability.skillRoot}/SKILL.md`) {
        issues.push(
            `record.capabilities[${index}].skillEntry must be the SKILL.md entry inside its skillRoot`
        );
    }
    validateExactGuidanceFields({
        issues,
        capability,
        index,
        allowedFields: [
            'kind',
            'owner',
            'skillRoot',
            'skillEntry',
            'contractTestRoot',
            'focusedCommand',
            'evaluationRoot',
            'contractPaths',
            'activation'
        ],
        role: 'skill-owned'
    });
}

function validateGuidanceRouter(issues, capability, index) {
    requireText(issues, capability.routingEntry, `record.capabilities[${index}].routingEntry`);
    if (!isSafeRepositoryPath(capability.routingEntry)) {
        issues.push(
            `record.capabilities[${index}].routingEntry must be a safe repository-relative path`
        );
    }
    if (
        Array.isArray(capability.contractPaths) &&
        capability.contractPaths.includes(capability.routingEntry)
    ) {
        issues.push(`record.capabilities[${index}].routingEntry must not also be a contract path`);
    }
    validateExactGuidanceFields({
        issues,
        capability,
        index,
        allowedFields: [
            'kind',
            'guidanceRole',
            'owner',
            'routingEntry',
            'contractTestRoot',
            'focusedCommand',
            'evaluationRoot',
            'contractPaths',
            'activation'
        ],
        role: 'router-owned'
    });
}

function validateExactGuidanceFields(input) {
    const { issues, capability, index, allowedFields, role } = input;
    const allowed = new Set(allowedFields);
    const unexpected = Object.keys(capability)
        .filter((field) => !allowed.has(field))
        .sort();
    if (unexpected.length > 0) {
        issues.push(
            `record.capabilities[${index}] guidance capability contains fields outside the ${role} ` +
                `union: ${unexpected.join(', ')}`
        );
    }
}

function validateContractPaths(input) {
    const { issues, contractPaths, index, required } = input;
    if (contractPaths === undefined && !required) {
        return;
    }
    if (
        !Array.isArray(contractPaths) ||
        contractPaths.some((contractPath) => !isSafeRepositoryPath(contractPath))
    ) {
        issues.push(
            `record.capabilities[${index}].contractPaths must contain safe repository-relative paths`
        );
    }
    if (Array.isArray(contractPaths) && new Set(contractPaths).size !== contractPaths.length) {
        issues.push(`record.capabilities[${index}].contractPaths must contain unique paths`);
    }
}

function validateCodeContractOwnership(issues, capabilities) {
    const reportedConflicts = new Set();
    for (const [capabilityIndex, capability] of capabilities.entries()) {
        if (!isRecord(capability) || capability.kind === 'guidance') {
            continue;
        }
        const contractPaths = (
            Array.isArray(capability.contractPaths) ? capability.contractPaths : []
        ).filter(isSafeRepositoryPath);
        const factContracts = new Set(
            (Array.isArray(capability.factContracts) ? capability.factContracts : []).filter(
                isSafeRepositoryPath
            )
        );
        for (const contractPath of contractPaths) {
            if (factContracts.has(contractPath)) {
                issues.push(
                    `${capabilityState(capability)} capability ${capability.owner} path ${contractPath} ` +
                        'cannot be both a fact contract and a contract path'
                );
            }
            collectCodeContractOwnershipConflicts({
                issues,
                capabilities,
                capability,
                capabilityIndex,
                contractPath,
                reportedConflicts
            });
        }
    }
}

function validateGuidanceEntryOwnership(issues, capabilities) {
    const ownerByEntry = new Map();
    for (const capability of capabilities) {
        if (!isRecord(capability) || capability.kind !== 'guidance') {
            continue;
        }
        const entry = guidanceEntry(capability);
        if (!isSafeRepositoryPath(entry)) {
            continue;
        }
        const previousOwner = ownerByEntry.get(entry);
        if (previousOwner !== undefined) {
            issues.push(
                `guidance entry ${entry} is declared by both ${previousOwner} and ${capability.owner}`
            );
        }
        else {
            ownerByEntry.set(entry, capability.owner);
        }
    }
}

function collectCodeContractOwnershipConflicts(input) {
    const { issues, capabilities, capability, capabilityIndex, contractPath, reportedConflicts } = input;
    for (const [otherIndex, otherCapability] of capabilities.entries()) {
        if (
            capabilityIndex === otherIndex ||
            !isRecord(otherCapability) ||
            !isOwnedByCapability(contractPath, otherCapability)
        ) {
            continue;
        }
        const conflictKey = [capability.owner, otherCapability.owner].sort().join('\0') + `\0${contractPath}`;
        if (reportedConflicts.has(conflictKey)) {
            continue;
        }
        reportedConflicts.add(conflictKey);
        const declaringCapability = selectContractConflictDeclarer(
            capability,
            otherCapability,
            contractPath
        );
        const conflictingCapability = declaringCapability === capability ? otherCapability : capability;
        const conflictingRole = isFactContract(contractPath, conflictingCapability)
            ? ' fact contract'
            : '';
        issues.push(
            `${capabilityState(declaringCapability)} capability ${declaringCapability.owner} ` +
                `contract path ${contractPath} conflicts with ${capabilityState(conflictingCapability)} ` +
                `capability ${conflictingCapability.owner}${conflictingRole}`
        );
    }
}

function selectContractConflictDeclarer(capability, otherCapability, contractPath) {
    const otherDeclaresSameContract = Array.isArray(otherCapability.contractPaths) &&
        otherCapability.contractPaths.includes(contractPath);
    if (
        otherDeclaresSameContract &&
        isPlannedCapability(otherCapability) &&
        !isPlannedCapability(capability)
    ) {
        return otherCapability;
    }
    return capability;
}

const isOwnedByCapability = capabilityOwnsPath;

export function guidanceRole(capability) {
    return capability?.guidanceRole === 'router' ? 'router' : 'skill';
}

export function guidanceEntry(capability) {
    return guidanceRole(capability) === 'router' ? capability?.routingEntry : capability?.skillEntry;
}

function isFactContract(repositoryPath, capability) {
    return (
        Array.isArray(capability.factContracts) && capability.factContracts.includes(repositoryPath)
    );
}

function capabilityState(capability) {
    return isPlannedCapability(capability) ? 'planned' : 'active';
}

function isWithin(candidate, root) {
    return candidate === root || candidate.startsWith(`${root}/`);
}

export function isSafeRepositoryPath(value) {
    if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) {
        return false;
    }
    if (
        value.startsWith('/') ||
        value.endsWith('/') ||
        value.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
        return false;
    }
    return true;
}

function requireText(issues, value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        issues.push(`${name} must be a non-empty string`);
    }
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}
