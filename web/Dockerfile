# Cloud Run image: build the SPA, then serve dist/ with the dependency-free server.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY server ./server
USER node
CMD ["node", "server/server.mjs"]
