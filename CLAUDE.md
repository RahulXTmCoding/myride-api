# myRide API — CLAUDE.md

## Project Overview
myRide is a group trip coordination app (think Spotify but for road trips).
Backend: NestJS + TypeORM + PostgreSQL (PostGIS) + Redis + LiveKit.

## Current Status (as of 2026-05-31)
**Stage: ~40% complete**

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
- All 13 database entities defined and auto-synced:
  - users, trips, trip_stops, trip_participants, user_stop_progress
  - trip_shareable_links, link_access_log, dynamic_stop_suggestions
  - sos_alerts, chat_messages (updated), message_reactions (new)
- TypeORM config, Joi validation schema, Firebase service
- **Chat system — full implementation** (2026-05-31):
  - `ChatGateway` (`/chat` namespace, Socket.IO + Redis adapter for multi-instance scaling)
  - Generic room system: `(room_type: trip|community, room_id: uuid)` — pluggable across all use cases
  - WS events: `chat:join`, `chat:leave`, `chat:send`, `chat:react`, `chat:typing`
  - Server events: `chat:message`, `chat:reaction_update`, `chat:typing`, `chat:joined`, `chat:kicked`, `chat:error`
  - `ChatController`: `GET /api/v1/chat/:room_type/:room_id/messages` (cursor pagination)
  - `ChatService`: saveMessage, getHistory, toggleReaction, checkRoomAccess, checkRateLimit, invalidateRoomAccessCache
  - `WsJwtGuard`: JWT auth at connection handshake + per-event defense-in-depth
  - `MessageReaction` entity with unique (message_id, user_id, emoji) constraint
  - Security: rate limiting (30 msg/60s), access check on every event, post-kick eviction via Redis pub/sub, HTML entity sanitization, emoji whitelist
- **Chat tests — full coverage** (2026-05-31):
  - `chat.service.spec.ts` — 37 unit tests: checkRoomAccess (cache hit/miss, community placeholder, trip approved/denied), invalidateRoomAccessCache, checkRateLimit (per-user/room isolation, send 30+1, react 60+1), saveMessage (HTML sanitize, reply snapshot, deleted/missing parent, 200-char truncation), getHistory (access denied, cursor, capped limit, deleted message content), toggleReaction (add, toggle-off, NotFoundException), findMessageById, reaction grouping
  - `chat.gateway.spec.ts` — 18 unit tests: handleConnection (no token, invalid token, valid), handleJoin (access denied, success, invalid room_type, no userId), handleLeave, handleSend (rate limited, access denied, success broadcast, unauthenticated, cheap-first order), handleReact (rate limited, message not found, cross-room security, success broadcast), handleTyping (silent drop on no access, invalid room_type, broadcast to room)
  - `test/chat.e2e-spec.ts` — integration tests (infra-skip pattern): WS connect/reject, room join/deny, message send+receive, room isolation, reaction toggle, cross-room reaction denial, REST history auth+access, cursor pagination, rate limiting (31st message)

### ❌ Not Yet Built (next priorities)
1. **Trip CRUD** — `src/modules/trips/` only has entities, no controller/service/module
2. **Users module** — no controller/service (only entity)
3. **WebSocket gateway for location** — real-time location tracking, trip updates
4. **Shareable links API** — generate/access/join via token
5. **LiveKit voice token endpoint** — `/voice-call/token`
6. **SOS API** — trigger/acknowledge emergency alerts
7. **Community module** — communities, members, invites (chat room access for `room_type=community` currently grants access to all authenticated users as placeholder)

## Architecture
```
src/
├── app.module.ts          ← AuthModule + ChatModule registered
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
    │   ├── redis.provider.ts
    │   ├── strategies/jwt.strategy.ts
    │   ├── guards/jwt-auth.guard.ts
    │   ├── decorators/current-user.decorator.ts
    │   └── dto/auth.dto.ts
    ├── chat/              ← ✅ COMPLETE
    │   ├── chat.module.ts
    │   ├── chat.gateway.ts        ← Socket.IO gateway (all WS events)
    │   ├── chat.service.ts        ← DB ops, access control, rate limiting
    │   ├── chat.controller.ts     ← REST: history + reactions
    │   ├── guards/ws-jwt.guard.ts
    │   ├── dto/
    │   │   ├── send-message.dto.ts
    │   │   ├── react-message.dto.ts
    │   │   └── get-history.dto.ts
    │   └── entities/
    │       ├── chat-message.entity.ts   (updated: room_type + room_id)
    │       └── message-reaction.entity.ts (new)
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
    ├── sos/
    │   └── entities/sos-alert.entity.ts     ← entity only
    └── voice-call/                          ← entity only
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

Note: once TripService approves/removes a participant, it must call:
  `ChatService.invalidateRoomAccessCache(userId, 'trip', tripId)`
  AND publish to Redis: `redis.publish('chat:kick', JSON.stringify({ room_type: 'trip', room_id: tripId, user_id: userId }))`

## Standing Instructions for Claude (applies on any machine)

### After Every Git Push — MANDATORY
After pushing any changes to this repo, you MUST:

1. **Update this CLAUDE.md** to reflect the new state:
   - Move completed items from ❌ to ✅ in the Done/Not Built lists
   - Update the "Current Status" date and completion percentage
   - Update the "Next Task to Implement" section
   - Add any new files/modules to the Architecture tree

2. **Commit and push the updated CLAUDE.md** in the same batch:
   ```bash
   git add CLAUDE.md
   git commit -m "docs: update CLAUDE.md status after <feature name>"
   git push
   ```

3. **Never push code without also pushing an updated CLAUDE.md.**

This keeps the checkpoint always in sync so the project can be resumed from any machine.
