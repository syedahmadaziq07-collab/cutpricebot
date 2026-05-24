FROM node:20-alpine
WORKDIR /app
COPY . .
CMD ["node", "artifacts/api-server/dist/index.mjs"]
