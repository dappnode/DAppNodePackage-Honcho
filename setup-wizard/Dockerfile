FROM node:20-alpine

WORKDIR /app

COPY server.cjs /app/server.cjs
COPY index.html /app/index.html

EXPOSE 8080

CMD ["node", "/app/server.cjs"]
