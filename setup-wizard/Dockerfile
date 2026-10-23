FROM node:22.23.4-alpine3.23

RUN apk add --no-cache --upgrade \
    'ca-certificates>=20261020' \
    'ca-certificates-bundle>=20261020'

WORKDIR /app

COPY server.cjs /app/server.cjs
COPY index.html /app/index.html

EXPOSE 8080

CMD ["node", "/app/server.cjs"]
