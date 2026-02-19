import {sql} from "./db.ts";

export const myPublisherId = crypto.randomUUID().toString();

console.log(`My publisher ID: ${myPublisherId}`)

export type PublishMessageKey = {
    topicId: string
    resourceId: string
    contextId: string
}

export type PublishMessage = {
    key: PublishMessageKey
    channel: string
    publisherId: string
    typeId: string
    payload: string
}

export async function notify(channel: string, message: PublishMessage) {
    await sql.notify(channel, JSON.stringify(message));
}
