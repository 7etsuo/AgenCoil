# Build from the repository root so the shared simulation in src/game is in
# the context:  docker build -f game-server/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY game-server/package.json game-server/package-lock.json ./game-server/
RUN cd game-server && npm ci --no-audit --no-fund
COPY src/game ./src/game
COPY game-server ./game-server
RUN cd game-server && npm run bundle

FROM node:22-alpine
WORKDIR /app/game-server
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/game-server/package.json ./
COPY --from=build /app/game-server/node_modules ./node_modules
COPY --from=build /app/game-server/dist ./dist
EXPOSE 8080
CMD ["node", "dist/dev.mjs"]
