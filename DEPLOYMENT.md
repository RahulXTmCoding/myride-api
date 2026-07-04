# myRide API — Deployment Guide

## Table of Contents
1. [Local Development](#1-local-development)
2. [Server Requirements](#2-server-requirements)
3. [VPS / Cloud Deployment (Production)](#3-vps--cloud-deployment-production)
4. [Environment Variables Reference](#4-environment-variables-reference)
5. [Database Migrations](#5-database-migrations)
6. [LiveKit Setup](#6-livekit-setup)
7. [Firebase Setup](#7-firebase-setup)
8. [Monitoring & Logs](#8-monitoring--logs)
9. [Common Issues](#9-common-issues)

---

## 1. Local Development

### Prerequisites
| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | https://nodejs.org |
| Docker Desktop | Latest | https://docker.com |
| Git | Latest | https://git-scm.com |

### Quick Start
```bash
# 1. Clone
git clone https://github.com/RahulXTmCoding/myride-api.git
cd myride-api

# 2. Environment
cp .env.example .env
# Edit .env — at minimum set FIREBASE_PROJECT_ID if using real phone auth

# 3. Start everything (Postgres + Redis + LiveKit + API)
npm run docker:up

# 4. Verify
curl http://localhost:3000
# → { "status": "ok" }
```

### ADB Port Forwarding (for Android emulator testing)
Run once after starting the emulator:
```bash
adb reverse tcp:3000 tcp:3000    # NestJS API
adb reverse tcp:7880 tcp:7880    # LiveKit WebSocket
adb reverse tcp:7881 tcp:7881    # LiveKit TCP/WebRTC
```

### Development without Docker (API only)
```bash
# Start only infrastructure
docker compose up -d postgres redis livekit

# Run API with hot-reload
npm run start:dev
```

---

## 2. Server Requirements

### Minimum (staging / small team)
- **CPU**: 2 vCPU
- **RAM**: 4 GB
- **Disk**: 20 GB SSD
- **OS**: Ubuntu 22.04 LTS
- **Open ports**: 80, 443, 3000, 7880, 7881, 50000–50100/UDP

### Recommended (production)
- **CPU**: 4 vCPU
- **RAM**: 8 GB
- **Disk**: 40 GB SSD
- Separate managed Postgres (e.g. Supabase, RDS, Neon)
- Separate managed Redis (e.g. Upstash, ElastiCache)
- LiveKit Cloud instead of self-hosted (livekit.io — free tier available)

### Cloud options
| Provider | Notes |
|----------|-------|
| **Render** | Easiest — free tier, auto-deploys from GitHub, managed Postgres add-on |
| **Railway** | One-click Postgres + Redis, good DX |
| **DigitalOcean App Platform** | $12/mo droplet, managed DB add-on |
| **AWS EC2 + RDS** | Full control, cheapest at scale |
| **Google Cloud Run** | Serverless containers, scales to zero |

---

## 3. VPS / Cloud Deployment (Production)

### Option A — Render (Recommended for getting started fast)

1. Push code to GitHub (main branch)

2. Go to https://render.com → **New Web Service**
   - **Runtime**: Docker
   - **Repo**: your GitHub repo
   - **Dockerfile**: `./Dockerfile`
   - **Branch**: `main`

3. Add a **Postgres** database (Render dashboard → New → PostgreSQL)
   - Copy the **Internal Database URL**

4. Add a **Redis** instance (Render dashboard → New → Redis)
   - Copy the **Internal Redis URL**

5. Set environment variables in Render dashboard (see §4)

6. Deploy — Render auto-deploys on every push to `main`

### Option B — VPS with Docker Compose

```bash
# On your server (Ubuntu 22.04)

# 1. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# 2. Install Docker Compose
sudo apt-get install docker-compose-plugin

# 3. Clone repo
git clone https://github.com/RahulXTmCoding/myride-api.git
cd myride-api

# 4. Create production env file
cp .env.example .env.production
nano .env.production
# Fill in all values (see §4)

# 5. Create a production compose override
cat > docker-compose.prod.yml << 'EOF'
services:
  api:
    command: npm run start:prod
    build:
      target: production
    restart: always
    env_file:
      - .env.production
  postgres:
    restart: always
  redis:
    restart: always
  livekit:
    restart: always
EOF

# 6. Build production image
docker compose -f docker-compose.yml -f docker-compose.prod.yml build

# 7. Start
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# 8. Check logs
docker compose logs -f api
```

### Production Dockerfile update
The current Dockerfile uses `start:dev` (hot-reload). For production, update it:

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM base AS build
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
```

### Nginx reverse proxy (optional, for HTTPS)
```nginx
server {
    listen 80;
    server_name api.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name api.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Get a free SSL cert:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

---

## 4. Environment Variables Reference

Copy `.env.example` and fill in these values:

```env
# ── App ──────────────────────────────────────────────────────────────────────
NODE_ENV=production
PORT=3000

# ── Database ─────────────────────────────────────────────────────────────────
# Format: postgresql://user:password@host:5432/dbname
DATABASE_URL=postgresql://myride:STRONG_PASSWORD@postgres:5432/myride

# For managed Postgres (Supabase / RDS / Neon):
# DATABASE_URL=postgresql://user:password@db.yourhost.com:5432/myride

# ── Redis ─────────────────────────────────────────────────────────────────────
# Format: redis://[:password@]host:6379[/db]
REDIS_URL=redis://redis:6379

# For managed Redis (Upstash):
# REDIS_URL=rediss://default:TOKEN@endpoint.upstash.io:6379

# ── JWT ──────────────────────────────────────────────────────────────────────
JWT_SECRET=CHANGE_THIS_TO_A_LONG_RANDOM_STRING_AT_LEAST_64_CHARS
JWT_REFRESH_SECRET=CHANGE_THIS_TO_ANOTHER_LONG_RANDOM_STRING

# ── Firebase (phone authentication) ──────────────────────────────────────────
FIREBASE_PROJECT_ID=your-firebase-project-id
# Path to service account JSON (or set FIREBASE_PRIVATE_KEY etc. individually)
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json

# ── LiveKit (voice calls) ─────────────────────────────────────────────────────
LIVEKIT_URL=ws://livekit:7880           # internal Docker URL
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret-dev-key-change-this-in-production

# For LiveKit Cloud:
# LIVEKIT_URL=wss://your-project.livekit.cloud
# LIVEKIT_API_KEY=APIxxxxx
# LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxx

# ── Postgres direct (for TypeORM if not using DATABASE_URL) ──────────────────
POSTGRES_DB=myride
POSTGRES_USER=myride
POSTGRES_PASSWORD=STRONG_PASSWORD
```

### Generating strong secrets
```bash
# JWT secret (64+ chars)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Or using openssl
openssl rand -hex 64
```

---

## 5. Database Migrations

TypeORM is configured with `synchronize: true` in development — it auto-creates/updates tables. **In production, disable this and use migrations instead.**

### Switch to migrations for production
In `src/config/typeorm.config.ts` (or wherever the TypeORM config is):
```ts
synchronize: process.env.NODE_ENV !== 'production',
migrationsRun: process.env.NODE_ENV === 'production',
```

### Run seed data (dev only)
```bash
# Seeds test trips, users, stops into local DB
docker compose exec postgres psql -U myride -d myride -f /docker-entrypoint-initdb.d/seed-test-data.sql

# Or from host (requires psql installed):
psql postgresql://myride:myride_dev_password@localhost:5433/myride -f seed-test-data.sql
```

---

## 6. LiveKit Setup

### Self-hosted (current dev setup)
LiveKit runs as a Docker container (see `docker-compose.yml`). Config is in `livekit.yaml`.

**For production on a VPS**, update `livekit.yaml`:
```yaml
# Replace node_ip with your server's PUBLIC IP
rtc:
  node_ip: YOUR_SERVER_PUBLIC_IP
  use_external_ip: false

# Change these keys!
keys:
  your-api-key: your-very-long-secret-key
```

### LiveKit Cloud (recommended for production)
1. Sign up at https://livekit.io/cloud
2. Create a project → get `API Key` + `API Secret` + `WSS URL`
3. Update `.env`:
   ```env
   LIVEKIT_URL=wss://your-project.livekit.cloud
   LIVEKIT_API_KEY=APIxxxxx
   LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxx
   ```
4. Free tier: 100 GB/month (sufficient for testing)

---

## 7. Firebase Setup

Required for production phone number OTP authentication.

1. Go to https://console.firebase.google.com
2. Create a project (or use existing)
3. Enable **Authentication → Phone** sign-in method
4. Add your country's phone number region policy (Settings → SMS region policy)
5. Go to **Project Settings → Service Accounts → Generate new private key**
6. Save the downloaded JSON as `firebase-service-account.json` in the repo root
   - ⚠️ This file is gitignored — never commit it
7. Set `FIREBASE_PROJECT_ID` in `.env`

For CI/CD environments where you can't copy a file, export the key fields as env vars:
```env
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@project.iam.gserviceaccount.com
FIREBASE_PROJECT_ID=your-project-id
```

---

## 8. Monitoring & Logs

### View live logs
```bash
# All services
docker compose logs -f

# API only
docker compose logs -f api

# Database
docker compose logs -f postgres
```

### Health check endpoint
```bash
curl https://api.yourdomain.com/
# → 200 OK
```

### Useful Docker commands
```bash
# Restart only the API (after code update)
docker compose restart api

# Rebuild and restart (after Dockerfile/dependency change)
docker compose up --build -d api

# Connect to Postgres shell
docker compose exec postgres psql -U myride -d myride

# Connect to Redis shell
docker compose exec redis redis-cli

# Check container resource usage
docker stats
```

---

## 9. Common Issues

### "relation does not exist" (TypeORM)
The database tables haven't been created yet. With `synchronize: true`, TypeORM creates them on first start. If it's off, run migrations manually.
```bash
docker compose restart api   # triggers synchronize on startup
```

### "Connection refused" to Postgres/Redis
The API container started before the DB was ready. The `depends_on: condition: service_healthy` in `docker-compose.yml` should prevent this, but if it persists:
```bash
docker compose down && docker compose up -d
```

### LiveKit "Could not establish PC connection"
The WebRTC ICE candidates are advertising the wrong IP.
- **Local / emulator**: `node_ip: 127.0.0.1` in `livekit.yaml` + ADB port forwarding
- **Production VPS**: `node_ip: <YOUR_SERVER_PUBLIC_IP>` + UDP ports 50000–50100 open in firewall

### Port 3000 already in use
```bash
lsof -i :3000       # macOS/Linux
netstat -ano | findstr :3000   # Windows
# Kill the process, then docker compose up
```

### "No space left on device" (Docker)
```bash
docker system prune -af --volumes   # ⚠️ removes all unused images + volumes
```
