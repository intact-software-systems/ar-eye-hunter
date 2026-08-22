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

export function hasMeaningfulText(value) {
    if (typeof value !== 'string') {
        return false;
    }
    const text = value.trim();
    return (
        text.length > 0 && !/^(?:tbd|todo|none|later|\.\.\.|-)|^\[[^\]]*\]$|^<[^>]*>$/iu.test(text)
    );
}

export function hasConcreteText(value) {
    if (!hasMeaningfulText(value)) {
        return false;
    }
    const visibleText = value
        .replace(/\\(?:[nrtbfv0]|u\{?[0-9a-f]{1,6}\}?)/giu, ' ')
        .replace(/[\p{Cc}\p{Cf}\p{P}\p{S}]+/gu, ' ')
        .replaceAll(/\s+/gu, ' ')
        .trim();
    if (visibleText.replaceAll(' ', '').length < 12) {
        return false;
    }
    return !/^(?:semantic coverage|runtime behavior|same file|supporting contract|source check)$/iu.test(
        visibleText
    );
}
