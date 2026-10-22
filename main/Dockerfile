FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
# better-sqlite3 est optionnel (inutile avec PostgreSQL)
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
