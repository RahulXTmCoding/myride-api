# myride-api

NestJS backend base repo for myRide.

## Prerequisites

- Node.js 20+
- npm 10+
- Docker + Docker Compose

## Local development (without Docker)

1. Copy env:

```powershell
Copy-Item .env.example .env
```

2. Install dependencies:

```powershell
npm install
```

3. Start API:

```powershell
npm run start:dev
```

Health endpoint:

```text
GET http://localhost:3000
```

If you only want infra in Docker (Postgres + Redis) and API on host:

```powershell
docker compose up -d postgres redis
```

## Local development (Docker: API + Postgres + Redis)

```powershell
npm run docker:up
```

Stop stack:

```powershell
npm run docker:down
```

View logs:

```powershell
npm run docker:logs
```

## Environment variables

See `.env.example`.
