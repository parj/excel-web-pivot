FROM ghcr.io/pnpm/pnpm:11 AS builder

RUN pnpm runtime set node 24 -g

WORKDIR /app

COPY . .

RUN pnpm install

EXPOSE 5173

CMD ["pnpm", "run", "dev"]
