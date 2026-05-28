# myRide API — CLAUDE.md

## Project Overview
myRide is a group trip coordination app (think Spotify but for road trips).
Backend: NestJS + TypeORM + PostgreSQL (PostGIS) + Redis + LiveKit.

## Current Status (as of 2026-05-28)
**Stage: ~25% complete**

### ✅ Done
- Full authentication system (dev OTP + Firebase production dual-mode)
  - `POST /api/v1/auth/request-otp` — request OTP (logs to console in dev)
  - `POST /api/v1/auth/login` — login with OTP
  - `POST /api/v1/auth/firebase-login` — login with Firebase ID token
  - `POST /api/v1/auth/refresh` — refresh JWT
  - `GET  /api/v1/auth/me` — get current user (JWT protected)
  - `GET  /api/v1/auth/mode` — check auth mode
  - `POST /api/v1/auth/logout`
- JWT access tokens (15min) + refresh tokens (30 days)
- Docker Compose: postgres (PostGIS 16), redis 7, livekit, api containers
- All 11 database entities defined and auto-synced:
  - users, trips, trip_stops, trip_participants, user_stop_progress
  - trip_shareable_links, link_access_log, dynamic_stop_suggestions
  - sos_alerts, chat_messages
- TypeORM config, Joi validation schema, Firebase service

### ❌ Not Yet Built (next priorities)
1. **Trip CRUD** — `src/modules/trips/` only has entities, no controller/service/module
2. **Users module** — no controller/service (only entity)
3. **WebSocket gateway** — real-time location, chat, trip updates
4. **Shareable links API** — generate/access/join via token
5. **LiveKit voice token endpoint** — `/voice-call/token`
6. **Chat API** — send/receive messages
7. **SOS API** — trigger/acknowledge emergency alerts
8. **AppModule registration** — currently only AuthModule is registered

## Architecture
```
src/
├── app.module.ts          ← Only AuthModule registered so far
├── app.controller.ts      ← GET / health check
├── app.service.ts         ← Health + DB/Redis probes
├── config/
│   ├── typeorm.config.ts  ← TypeORM factory (postgres/postgis)
│   └── validation.schema.ts ← Joi env validation
└── modules/
    ├── auth/              ← ✅ COMPLETE
    │   ├── auth.module.ts
    │   ├── auth.controller.ts
    │   ├── auth.service.ts
    │   ├── firebase.service.ts
    │   ├── strategies/jwt.strategy.ts
    │   ├── guards/jwt-auth.guard.ts
    │   ├── decorators/current-user.decorator.ts
    │   └── dto/auth.dto.ts
    ├── users/
    │   └── entities/user.entity.ts     ← entity only, no module
    ├── trips/
    │   └── entities/                   ← entities only, no module
    │       ├── trip.entity.ts
    │       ├── trip-stop.entity.ts
    │       ├── trip-participant.entity.ts
    │       ├── trip-shareable-link.entity.ts
    │       ├── link-access-log.entity.ts
    │       ├── dynamic-stop-suggestion.entity.ts
    │       └── user-stop-progress.entity.ts
    ├── chat/
    │   └── entities/chat-message.entity.ts  ← entity only
    └── sos/
        └── entities/sos-alert.entity.ts     ← entity only
```

## Environment Setup (New Machine)

### Prerequisites
- Node.js 20+
- Docker Desktop with WSL2 enabled
- Git

### Quick Start
```bash
git clone https://github.com/RahulXTmCoding/myride-api.git
cd myride-api
cp .env.example .env
npm install
docker compose up -d postgres redis livekit
docker compose up -d api
```

### Manual Backend Start (if Docker API container not used)
```bash
# Start infra only via Docker
docker compose up -d postgres redis livekit
# Run backend locally with hot-reload
npm run start:dev
```

### WSL2 / Docker Troubleshooting (Windows)
If Docker shows "Engine stopped":
1. Open PowerShell as Administrator:
```powershell
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
```
2. Restart computer
3. `wsl --install -d Ubuntu-22.04`
4. Docker Desktop → Settings → General → "Use WSL 2 based engine"

### Test Auth Flow
```bash
# Check mode
curl http://localhost:3000/api/v1/auth/mode
# Request OTP (check server console for code)
curl -X POST http://localhost:3000/api/v1/auth/request-otp \
  -H "Content-Type: application/json" -d '{"phone":"+10000000000"}'
# Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" -d '{"phone":"+10000000000","otp":"XXXXXX"}'
```

## Key Environment Variables (.env)
```env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://myride:myride_dev_password@localhost:5432/myride
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-super-secret-jwt-key-change-in-production-min-32-chars
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=30d
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret-dev-key-change-this-in-production
LIVEKIT_WS_URL=ws://localhost:7880
ENABLE_FIREBASE=false
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
```

## Next Task to Implement
**Trip CRUD module** — create `src/modules/trips/trips.module.ts`, `trips.controller.ts`, `trips.service.ts` and register in `app.module.ts`.

Endpoints needed:
- `POST   /api/v1/trips` — create trip
- `GET    /api/v1/trips` — list my trips
- `GET    /api/v1/trips/:id` — get trip details
- `PUT    /api/v1/trips/:id` — update trip
- `DELETE /api/v1/trips/:id` — delete trip
- `POST   /api/v1/trips/:id/start` — start trip
- `POST   /api/v1/trips/:id/complete` — complete trip
- `POST   /api/v1/trips/:id/participants` — invite participant
- `POST   /api/v1/trips/:id/stops` — add stop
