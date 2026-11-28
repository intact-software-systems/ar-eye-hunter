import { hasConcreteText, hasMeaningfulText } from '../test-structure-coupling-interaction-requirement.mjs';

export const DIRECT_WRITE_REGISTRY_FENCE = 'app-inbox-direct-write-registry-v1';
export const DIRECT_WRITE_RULE_DATE = '2026-11-27';
export const DIRECT_WRITE_FACT_SETS = [
    'admissionBackendImplementations',
    'admissionBackendConstructions',
    'admissionBackendWrites',
    'wiringImports',
    'transactionOpeners',
    'sqlWriteFiles',
    'nonTransactionHandleFeeds',
    'repositoryWriteCallers',
    'rowFamilies'
];
export const DIRECT_WRITE_CLASSES = [
    'app-inbox',
    'queue-machinery',
    'adapter',
    'passive-statement',
    'downstream-work',
    'no-production-caller',
    'public-surface',
    'composition-root',
    'browser-or-memory',
    'transport-direct'
];

const REVIEW_FIELDS = ['review', 'answer', 'question', 'options', 'approval', 'recommended', 'answeredOn'];
const UNDER_REVIEW_FIELDS = ['state', 'since', 'raised'];
const ANSWER_FIELDS = ['answer', 'question', 'options', 'approval', 'recommended', 'costOfAppInbox', 'answeredOn'];
const MODULE_LISTS = ['wiringModules', 'repositoryContractModules'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function toDirectWriteRegistry(markdown) {
    const pattern = new RegExp(`\`\`\`${DIRECT_WRITE_REGISTRY_FENCE}\\s*\\n([\\s\\S]*?)\\n\`\`\``, 'gu');
    const blocks = [...markdown.matchAll(pattern)].map((match) => match[1]);
    if (blocks.length !== 1) {
        return {
            kind: 'invalid',
            issues: [
                blocks.length === 0
                    ? `the document holds no \`\`\`${DIRECT_WRITE_REGISTRY_FENCE} block`
                    : `the document holds ${blocks.length} \`\`\`${DIRECT_WRITE_REGISTRY_FENCE} blocks; it must hold one`
            ]
        };
    }
    try {
        return { kind: 'parsed', registry: JSON.parse(blocks[0]) };
    }
    catch (error) {
        return { kind: 'invalid', issues: [`the registry block is not valid JSON: ${toError(error).message}`] };
    }
}

export function validateDirectWriteRegistry(registry) {
    if (!isRecord(registry)) {
        return ['the registry block must be a JSON object'];
    }
    const stores = Array.isArray(registry.stores) ? registry.stores : [];
    const storeIds = new Set(stores.map((store) => store?.id));
    return [
        ...validateRegistryHeader(registry),
        ...stores.flatMap(validateStore),
        ...validateUniqueIdentities('stores', stores),
        ...DIRECT_WRITE_FACT_SETS.flatMap((factSet) => validateFactSetEntries(registry, factSet, storeIds))
    ];
}

export function toApprovedStoreIds(registry) {
    return (registry.stores ?? [])
        .filter((store) => store.review?.state === 'approved')
        .map((store) => store.id)
        .toSorted();
}

function validateRegistryHeader(registry) {
    const issues = [];
    if (registry.version !== 1) {
        issues.push('version must be 1');
    }
    for (const field of ['owner', 'reviewCondition']) {
        if (!hasConcreteText(registry[field])) {
            issues.push(`${field} must be concrete text`);
        }
    }
    for (const field of [...MODULE_LISTS, 'stores', ...DIRECT_WRITE_FACT_SETS]) {
        if (!Array.isArray(registry[field])) {
            issues.push(`${field} must be a list`);
        }
    }
    for (const field of MODULE_LISTS) {
        if (Array.isArray(registry[field]) && !registry[field].every(isRepositoryPath)) {
            issues.push(`${field} must hold repository paths`);
        }
    }
    const topics = Array.isArray(registry.workTopicConstants) ? registry.workTopicConstants : undefined;
    if (!topics?.every((topic) => isRepositoryPath(topic?.path) && hasMeaningfulText(topic?.name))) {
        issues.push('workTopicConstants must list { path, name } pairs');
    }
    return issues;
}

function validateStore(store) {
    const label = `stores ${store?.id}`;
    if (!isRecord(store) || !hasMeaningfulText(store.id)) {
        return ['stores: every store needs an id'];
    }
    const issues = [];
    if (store.class !== 'transport-direct') {
        issues.push(`${label}: a store is class transport-direct`);
    }
    if (store.review === undefined) {
        issues.push(`${label}: review is required`);
    }
    if (!isConcreteTextList(store.rows, 1)) {
        issues.push(`${label}: rows must list every row written`);
    }
    if (!isConcreteTextList(store.incomingPaths, 1)) {
        issues.push(`${label}: incomingPaths must list every incoming path that writes`);
    }
    if (store.review !== undefined) {
        issues.push(...validateReview(store.review).map((issue) => `${label}: ${issue}`));
    }
    return issues;
}

function validateReview(review) {
    if (review?.state === 'under-review') {
        return validateUnderReview(review);
    }
    if (review?.state === 'approved') {
        return validateApproval(review);
    }
    return ['review.state must be "under-review" or "approved"'];
}

function validateUnderReview(review) {
    const issues = ANSWER_FIELDS
        .filter((field) => field in review)
        .map((field) => `an under-review entry carries no ${field} field`);
    const unexpectedFields = Object.keys(review).filter((field) =>
        !UNDER_REVIEW_FIELDS.includes(field) && !ANSWER_FIELDS.includes(field)
    );
    issues.push(...unexpectedFields.map((field) => `an under-review entry carries no ${field} field`));
    if (!isIsoDate(review.since)) {
        issues.push('since must be an ISO date (YYYY-MM-DD)');
    }
    if (!hasConcreteText(review.raised)) {
        issues.push('raised must say where the review was raised');
    }
    return issues;
}

function validateApproval(review) {
    const issues = [...validateApprovalQuestion(review.question), ...validateApprovalOptions(review)];
    if (review.costOfAppInbox !== 'not measured' && !hasConcreteText(review.costOfAppInbox)) {
        issues.push('costOfAppInbox must be a measurement or exactly "not measured"');
    }
    if (!hasConcreteText(review.answer)) {
        issues.push('answer must be the maintainer answer word for word, not placeholder text');
    }
    issues.push(...validateAnswerDate(review.answeredOn));
    return issues;
}

function validateApprovalQuestion(question) {
    if (!hasConcreteText(question)) {
        return ['question must be the question word for word, not placeholder text'];
    }
    return question.includes('outside AppInbox') ? [] : ['the question must contain "outside AppInbox"'];
}

function validateApprovalOptions(review) {
    const options = Array.isArray(review.options) ? review.options : [];
    const issues = [];
    if (!isConcreteTextList(options, 2)) {
        issues.push('options must list at least two options word for word');
    }
    if (!options.some((option) => /AppInbox/u.test(String(option).replaceAll('outside AppInbox', '')))) {
        issues.push('one option must name AppInbox as the path');
    }
    if (!options.includes(review.recommended)) {
        issues.push('recommended must be one of the options');
    }
    return issues;
}

function validateAnswerDate(answeredOn) {
    if (!isIsoDate(answeredOn)) {
        return ['answeredOn must be an ISO date (YYYY-MM-DD)'];
    }
    return answeredOn < DIRECT_WRITE_RULE_DATE
        ? [`answeredOn must not be before ${DIRECT_WRITE_RULE_DATE}, the day the rule was made`]
        : [];
}

function validateFactSetEntries(registry, factSet, storeIds) {
    const entries = Array.isArray(registry[factSet]) ? registry[factSet] : [];
    return [
        ...entries.flatMap((entry) => validateFactEntry(factSet, entry, storeIds)),
        ...validateUniqueIdentities(factSet, entries)
    ];
}

function validateFactEntry(factSet, entry, storeIds) {
    const label = `${factSet} ${entry?.id}`;
    if (!isRecord(entry) || !hasMeaningfulText(entry.id)) {
        return [`${factSet}: every entry needs an id`];
    }
    const issues = [];
    if (!DIRECT_WRITE_CLASSES.includes(entry.class)) {
        issues.push(`${label}: unknown class "${entry.class}"`);
    }
    if (!hasConcreteText(entry.basis)) {
        issues.push(`${label}: basis must say what was verified, not placeholder text`);
    }
    issues.push(...validateEntryStores(label, entry, storeIds));
    for (const field of REVIEW_FIELDS.filter((name) => name in entry)) {
        issues.push(`${label}: only a transport store carries a review; this entry carries ${field}`);
    }
    return issues;
}

function validateEntryStores(label, entry, storeIds) {
    if (entry.class !== 'transport-direct') {
        return entry.stores === undefined ? [] : [`${label}: only a transport-direct surface names stores`];
    }
    if (!Array.isArray(entry.stores) || entry.stores.length === 0) {
        return [`${label}: a transport-direct surface names the stores it writes`];
    }
    return entry.stores
        .filter((store) => !storeIds.has(store))
        .map((store) => `${label}: unknown store "${store}"`);
}

function validateUniqueIdentities(listName, entries) {
    const counts = new Map();
    for (const entry of entries) {
        counts.set(entry?.id, (counts.get(entry?.id) ?? 0) + 1);
    }
    return [...counts]
        .filter(([, count]) => count > 1)
        .map(([id, count]) => `${listName} ${id}: the identity is registered ${count} times`);
}

function isConcreteTextList(value, minimum) {
    return Array.isArray(value) && value.length >= minimum && value.every(hasConcreteText);
}

function isIsoDate(value) {
    return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isRepositoryPath(value) {
    return typeof value === 'string' && /^[a-z0-9][\w./-]*\.ts$/u.test(value);
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value) {
    return value instanceof Error ? value : new Error(String(value));
}
