# ─────────────────────────────────────────────
# Stage 1: Install production dependencies only
# ─────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ─────────────────────────────────────────────
# Stage 2: Build (all deps + TypeScript compile)
# ─────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ─────────────────────────────────────────────
# Stage 3: Production image (lean runtime)
# ─────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Install curl for HEALTHCHECK
RUN apk add --no-cache curl

# Copy only what we need from previous stages
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist

# Run as non-root for security
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

CMD ["node", "dist/main"]
