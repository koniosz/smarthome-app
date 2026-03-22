# ─── Stage 1: Build Frontend ─────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ .
RUN NODE_OPTIONS="--max-old-space-size=2048" npm run build

# ─── Stage 2: Build Backend ──────────────────────────────────────────────────
FROM node:20-alpine AS backend-builder
WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci

COPY backend/ .

# Generate Prisma Client
RUN npx prisma generate

# Compile TypeScript
RUN npm run build

# ─── Stage 3: Production ─────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Install only production deps
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# Copy compiled backend
COPY --from=backend-builder /app/backend/dist ./backend/dist

# Copy Prisma client (generated)
COPY --from=backend-builder /app/backend/node_modules/.prisma ./backend/node_modules/.prisma
COPY --from=backend-builder /app/backend/node_modules/@prisma ./backend/node_modules/@prisma

# Copy Prisma schema (needed for migrations at startup)
COPY backend/prisma ./backend/prisma

# Copy built frontend (served as static files by backend)
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Create data directory for attachments (mount a volume here in production)
RUN mkdir -p /app/backend/data/attachments

EXPOSE 4001

ENV NODE_ENV=production

# Run migrations then start the server
CMD sh -c "cd /app/backend && npx prisma db push && node dist/index.js"
