type ResultEvidence = Readonly<{
    valid: boolean
    result: unknown
    receipt?: Readonly<{
        commandId: string
        outboxIds: readonly string[]
        identityKind: ReceiptEffectIdentityKind
    }>
    failure?: string
}>

type RecordValue = Record<string, unknown>

export type ReceiptEffectIdentityKind = 'logical-msg-id' | 'physical-resource-id'

export function parseEvidenceJson(value: string | null): unknown {
    if (!value) return undefined
    try {
        return JSON.parse(value)
    } catch {
        return undefined
    }
}

export function nestedEvidenceJson(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const parsed = parseEvidenceJson(value)
    return parsed === undefined ? value : parsed
}

export function collectEvidenceNamedStrings(
    value: unknown,
    names: ReadonlySet<string>,
    into: Set<string>,
): void {
    const candidate = nestedEvidenceJson(value)
    if (!candidate || typeof candidate !== 'object') return
    if (Array.isArray(candidate)) {
        candidate.forEach((item) => collectEvidenceNamedStrings(item, names, into))
        return
    }
    for (const [key, child] of Object.entries(candidate)) {
        if (names.has(key) && typeof child === 'string') into.add(child)
        if (names.has(key) && Array.isArray(child)) {
            child.filter((item): item is string => typeof item === 'string')
                .forEach((item) => into.add(item))
        }
        collectEvidenceNamedStrings(child, names, into)
    }
}

export function validatePersistedAppInboxResult(input: Readonly<{
    commandType: string
    commandIds: readonly string[]
    resultStatus: string
    resultResource: string | null
}>): ResultEvidence {
    if (!['COMPLETED', 'FAILED'].includes(input.resultStatus)) {
        return invalid(undefined, 'missing-result-status')
    }
    const result = parseRecord(input.resultResource)
    if (!result) return invalid(undefined, 'malformed-result-resource')
    if (input.resultStatus === 'FAILED') {
        return typeof result.code === 'string' || typeof result.message === 'string'
            ? { valid: true, result }
            : invalid(result, 'malformed-failure-result')
    }
    if (input.commandType.startsWith('CLIENT_')) {
        const either = record(result.result)
        const right = record(either?.right)
        if (result.status !== 'ok' || !right || !record(right.snapshot) ||
            !Object.hasOwn(right, 'event')) {
            return invalid(result, 'malformed-client-result')
        }
        return { valid: true, result }
    }
    if (input.commandType.startsWith('GROUP_PRESENCE_')) {
        return validateReceiptResult(result, input.commandIds, 'physical-resource-id')
    }
    if (input.commandType.startsWith('TOPOLOGY_CONFIG_') ||
        input.commandType.startsWith('TOPOLOGY_OVERRIDE_')) {
        const receipt = record(result.receipt)
        return receipt
            ? validateReceiptResult(receipt, input.commandIds, 'logical-msg-id', result)
            : invalid(result, 'missing-topology-receipt')
    }
    if (input.commandType === 'TOPOLOGY_RECONFIGURE') {
        const requestId = readMatchingId(result.requestId, input.commandIds)
        const outboxId = nonEmptyString(result.outboxId)
        return result.status === 'queued' && requestId && outboxId
            ? {
                valid: true,
                result,
                receipt: {
                    commandId: requestId,
                    outboxIds: [outboxId],
                    identityKind: 'logical-msg-id',
                },
            }
            : invalid(result, 'malformed-topology-reconfigure-result')
    }
    if (input.commandType.startsWith('GROUP_')) {
        const either = record(result.result)
        const right = record(either?.right)
        const left = either?.left
        const validStatus = ['ok', 'created', 'error'].includes(String(result.status))
        const validEither = right
            ? record(right.snapshot) !== undefined && Object.hasOwn(right, 'event')
            : typeof left === 'string'
        return validStatus && validEither
            ? { valid: true, result }
            : invalid(result, 'malformed-group-result')
    }
    return { valid: true, result }
}

function validateReceiptResult(
    receipt: RecordValue,
    commandIds: readonly string[],
    identityKind: ReceiptEffectIdentityKind,
    result: RecordValue = receipt,
): ResultEvidence {
    const commandId = readMatchingId(receipt.commandId, commandIds)
    const outboxIds = readUniqueIds(receipt.outboxIds)
    if (!commandId || !outboxIds || typeof receipt.outcome !== 'string' ||
        !Number.isSafeInteger(receipt.attemptCount)) {
        return invalid(result, 'malformed-or-mismatched-receipt')
    }
    return { valid: true, result, receipt: { commandId, outboxIds, identityKind } }
}

function parseRecord(value: string | null): RecordValue | undefined {
    if (typeof value !== 'string') return undefined
    try {
        return record(JSON.parse(value))
    } catch {
        return undefined
    }
}

function record(value: unknown): RecordValue | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : undefined
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readMatchingId(value: unknown, commandIds: readonly string[]): string | undefined {
    const id = nonEmptyString(value)
    return id && commandIds.includes(id) ? id : undefined
}

function readUniqueIds(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value) || !value.every((id) => nonEmptyString(id))) return undefined
    const ids = value as string[]
    return new Set(ids).size === ids.length ? ids : undefined
}

function invalid(result: unknown, failure: string): ResultEvidence {
    return { valid: false, result, failure }
}
