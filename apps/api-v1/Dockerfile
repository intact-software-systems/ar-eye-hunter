# apps/api/Dockerfile
FROM denoland/deno:alpine

WORKDIR /app
COPY . .

RUN deno cache src/main.ts

EXPOSE 8000
CMD ["run", "--allow-net", "src/main.ts"]
