FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data

ENV NODE_ENV=production
ENV PORT=4173
ENV DATA_DIR=/data

EXPOSE 4173

USER node

CMD ["node", "server.js"]
