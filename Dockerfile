FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install mongoose
CMD ["node", "artifacts/api-server/dist/index.mjs"]
