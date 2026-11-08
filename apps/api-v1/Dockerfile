# apps/api-v1/Dockerfile
FROM oven/bun:alpine

WORKDIR /app
COPY . .

RUN bun install

EXPOSE 8000
CMD ["bun", "run", "src/main.ts"]
