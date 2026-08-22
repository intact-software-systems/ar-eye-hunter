const requirementKeys = [
    'failureRationale',
    'interactionKind',
    'observableEffect',
    'ownedPort',
    'requiredConstraint'
];

export function isConcreteInteractionRequirement(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const actualKeys = Object.keys(value).toSorted();
    return actualKeys.length === requirementKeys.length &&
        actualKeys.every((key, index) => key === requirementKeys[index]) &&
        ['absence', 'count', 'order'].includes(value.interactionKind) &&
        ['failureRationale', 'observableEffect', 'ownedPort', 'requiredConstraint'].every((field) =>
            hasConcreteText(value[field])
        );
}

function hasConcreteText(value) {
    if (typeof value !== 'string') {
        return false;
    }
    const visibleText = value
        .replace(/[\p{Cc}\p{Cf}\p{P}\p{S}]+/gu, ' ')
        .replaceAll(/\s+/gu, ' ')
        .trim();
    return visibleText.replaceAll(' ', '').length >= 12;
}
