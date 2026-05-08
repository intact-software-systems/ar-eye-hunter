# ar-eye-hunter

AR game POC

## P2P version

Online game without a trace. Data is born when you enter and is gone when you leave, and most of the data was created
and only lived on your device.

## apps/api server

Deno web server

Deployed using `Deno Deploy`

## apps/api-v1 server

Deno web server (v1) mirroring `apps/api`

Deployed using `Deno Deploy`

## apps/web SPA

Framework free front-end

Deployed as static CDN using Cloudflare

## Groups

A group is created and owned by one peer.

Peers can join group by asking group owner (can be AUTO).

The SPA builds a local cache of public groups.

## Web RTC session

Session id with objects stored in Postgres DB.

### Resilient inbox and outbox in SPA

Implement in typescript so it can be used both on server and front-end.

### Outbox service to RTC

Services to implement

```text
- Send to one peer
- Send to a list of peers
```

Also, implement a multicast approach with a shared group view

### Inbox service from RTC

Services to implement

```text
- Receive from one peer
- Receive from a list of peers
```

Also, implement a multicast approach with a shared group view

In an inbox that means, forward message to peers as well as local SPA.

## API tokens

```text
CLOUDFLARE_API_TOKEN = D081AEEA-4248-4B04-BBF3-B86CE074BC18
CLOUDFLARE_ACCOUNT_ID = ar-eye-hunter 
```


## WebRTC and ICE/TURN

#### TURN server

Use [Metered](https://dashboard.metered.ca/turnserver/app/69787c9391a10f7b2c9cb989)

Free plan

# Various

```typescript
export type ALMessageKey = {
    readonly topicId: string
    readonly resourceId: string
    readonly contextId: string
}

export type ALMessageContext = {
    readonly mode: "unicast" | "multicast" | "broadcast"
    readonly orig: string
    readonly from: string
    readonly to: readonly string[]
    readonly groupId: string
    readonly topicId: string
    readonly sessionId: string
    readonly scope: "room" | "world" | "all"
    readonly ttl: number // hops
}

export type ALMessageHistory = {
    readonly visited: readonly string[]
    readonly remainingTtl: number // hops
}

export type ALMessageAudit = {
    readonly date: string
    readonly createdBy: string
    readonly createdTs: number
}

export type ALMessageReceptionStateAudit = {
    readonly receivedDate: string
    readonly receivedTs: number
    readonly receivedBy: string
}

export type ALMessageActions = {
    readonly ack: boolean
}

export type ALMessageQoS = {
    readonly ownership: "shared" | "exclusive"
    readonly reliability: "best-effort" | "reliable"
}

export type ALRouting = {
    readonly v: string
    readonly key: ALMessageKey
    readonly typeId: string
    readonly resource: string
    readonly context: ALMessageContext
    readonly qos: ALMessageQoS
    readonly history: ALMessageHistory
    readonly audit: ALMessageAudit
    readonly actions: ALMessageActions
}
```
