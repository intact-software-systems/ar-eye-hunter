# ar-eye-hunter
AR game POC


## apps/api server

Deno web server 

Deployed using `Deno Deploy`


## apps/web SPA

Framework free front-end

Deployed as static CDN using Cloudflare

## API tokens

```text
CLOUDFLARE_API_TOKEN = D081AEEA-4248-4B04-BBF3-B86CE074BC18
CLOUDFLARE_ACCOUNT_ID = ar-eye-hunter 
```

## WebRTC and ICE/TURN

```text
TURN_URLS = turns:turn.yourdomain.com:443?transport=tcp,turn:turn.yourdomain.com:3478?transport=udp 
TURN_SHARED_SECRET = B9B027AC-F7F3-4BDB-9DBC-3300AF6E6DED
TURN_TTL_SECONDS = 600
```

#### TURN server

Use [Metered](https://dashboard.metered.ca/turnserver/app/69787c9391a10f7b2c9cb989)

Free plan
