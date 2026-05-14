// import toJsonSchema from 'npm:@openapi-contrib/openapi-schema-to-json-schema@latest'
// import jsf from 'npm:json-schema-faker@latest'

// import maps:
//    "openapi-schema-to-json-schema": "npm:@openapi-contrib/openapi-schema-to-json-schema@latest",
//    "json-schema-faker": "npm:json-schema-faker@latest"
// After fix use this one: import jsf from 'npm:json-schema-faker@latest/esm'
// jsf.option({
//     useExamplesValue: true,
//     random: () => 0.000001
// })

// export const SchemaType = {
//     OPENAPI: 'openapi',
//     JSON: 'json'
// }

// export function toSchemaType(schema) {
//     return schema?.openapi ? SchemaType.OPENAPI : SchemaType.JSON
// }
//
// export function toJsonMock(type, schema) {
//     return undefined
// }

/*
export function toJsonMock(type, schema) {
    if (!schema) {
        return undefined
    }

    switch (type) {
        case SchemaType.OPENAPI:
            return toJsonMockFromOpenapi(schema)
        case SchemaType.JSON:
        default:
            return toJsonMockFromJsonSchema(schema)
    }
}

function toJsonMockFromOpenapi(schema) {
    let jsonSchema = toJsonSchema(schema)

    if (jsonSchema?.properties) {
        jsonSchema.required = Object.entries(jsonSchema?.properties)
            .map(([key, value]) => {
                if (value?.type === 'array') {
                    return key
                }
                return value?.required ? key : undefined
            })
            .filter(v => v !== undefined)
    }

    return jsf.generate(jsonSchema)
}

function toJsonMockFromJsonSchema(schema) {
    return jsf.generate(schema)
}
*/

type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export interface JsonObject {
    [key: string]: JsonValue | undefined
}
export interface JsonArray extends Array<JsonValue> {}

type SchemaObject = Record<string, unknown>

type JsonSchema = SchemaObject & {
    type?: string | string[]
    properties?: Record<string, JsonSchema>
    items?: JsonSchema
    enum?: JsonValue[]
    const?: JsonValue
    example?: JsonValue
    examples?: JsonValue[]
    default?: JsonValue
    format?: string
    $ref?: string
}

export const SchemaType = {
    OPENAPI: 'openapi',
    SWAGGER: 'swagger',
    JSON: 'json',
} as const

type SchemaTypeValue = typeof SchemaType[keyof typeof SchemaType]

function asRecord(value: unknown): SchemaObject {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as SchemaObject
        : {}
}

function asJsonSchema(value: unknown): JsonSchema {
    return asRecord(value) as JsonSchema
}

export function toSchemaType(schema: unknown): SchemaTypeValue {
    const record = asRecord(schema)

    if (record.openapi) {
        return SchemaType.OPENAPI
    }

    if (record.swagger) {
        return SchemaType.SWAGGER
    }

    return SchemaType.JSON
}

function resolveRef(document: unknown, ref: string): unknown {
    if (!ref.startsWith('#/')) {
        return undefined
    }

    return ref
        .replace(/^#\//, '')
        .split('/')
        .reduce<unknown>((current, part) => {
            return current && typeof current === 'object'
                ? (current as SchemaObject)[part]
                : undefined
        }, document)
}

function resolveSchema(schema: unknown, document?: unknown): JsonSchema {
    const schemaRecord = asJsonSchema(schema)

    if (schemaRecord.$ref && document) {
        const resolved = resolveRef(document, schemaRecord.$ref)
        return resolveSchema(resolved, document)
    }

    return schemaRecord
}

function firstType(type: string | string[] | undefined): string | undefined {
    return Array.isArray(type)
        ? type.find(value => value !== 'null') || type[0]
        : type
}

function toStringMock(schema: JsonSchema): string {
    switch (schema.format) {
        case 'date-time':
            return '2026-05-11T00:00:00.000Z'
        case 'date':
            return '2026-05-11'
        case 'uuid':
            return '00000000-0000-4000-8000-000000000000'
        default:
            return 'string'
    }
}

function toNumberMock(schema: JsonSchema): number {
    return firstType(schema.type) === 'integer'
        ? 1
        : 1.1
}

function toObjectMock(schema: JsonSchema, document?: unknown): JsonObject {
    const properties = asRecord(schema.properties)

    return Object.fromEntries(
        Object.entries(properties)
            .map(([key, value]) => [key, toJsonMockFromSchema(value, document)])
    )
}

function toJsonMockFromSchema(schemaInput: unknown, document?: unknown): JsonValue {
    const schema = resolveSchema(schemaInput, document)

    if (schema.const !== undefined) {
        return schema.const
    }

    if (schema.example !== undefined) {
        return schema.example
    }

    if (Array.isArray(schema.examples) && schema.examples.length > 0) {
        return schema.examples[0]
    }

    if (schema.default !== undefined) {
        return schema.default
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum[0]
    }

    switch (firstType(schema.type)) {
        case 'object':
            return toObjectMock(schema, document)
        case 'array':
            return [toJsonMockFromSchema(schema.items || {}, document)]
        case 'integer':
        case 'number':
            return toNumberMock(schema)
        case 'boolean':
            return true
        case 'null':
            return null
        case 'string':
            return toStringMock(schema)
        default:
            if (schema.properties) {
                return toObjectMock(schema, document)
            }
            if (schema.items) {
                return [toJsonMockFromSchema(schema.items, document)]
            }
            return toStringMock(schema)
    }
}

export function toJsonMock(type: SchemaTypeValue | string | undefined, schema: unknown, document?: unknown): JsonValue {
    if (schema === undefined || schema === null) {
        return {}
    }

    switch (type) {
        case SchemaType.OPENAPI:
        case SchemaType.SWAGGER:
            return toJsonMockFromSchema(schema, document)
        case SchemaType.JSON:
        default:
            return toJsonMockFromSchema(schema)
    }
}