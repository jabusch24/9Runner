# Demo UI + CLI image. Also handy as a load generator on a cloud VM:
#   docker run --env-file .env -v $PWD/results:/app/results 9runner node dist/src/cli/index.js benchmark iwm
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY public ./public
RUN npm run build
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/src/server/index.js"]
