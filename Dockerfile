FROM node:20-alpine

WORKDIR /app

COPY server.mjs ./
COPY setup.mjs ./
COPY package.json ./

ENV CLAUDE_SESSION_TOKEN="" \
    CLAUDE_COOKIES=""

EXPOSE 3456

CMD ["node", "server.mjs"]
