# ==============================================================================
# Prep404 High-Performance Fastify & Real-Time Engine Dockerfile
# Multi-stage production build (Node.js 20 on Alpine Linux)
# ==============================================================================

# Stage 1: Build Environment
FROM node:20-alpine AS builder

WORKDIR /app

# Install build tools if needed
RUN apk add --no-cache python3 make g++

# Copy package manifests first for optimal layer caching
COPY package*.json ./

# Install all dependencies (including devDependencies for TypeScript compilation)
RUN npm ci

# Copy TypeScript config and source code
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript to production JavaScript in dist/
RUN npm run build

# Stage 2: Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment flags
ENV NODE_ENV=production
ENV PORT=4040
ENV HOST=0.0.0.0

# Copy package manifests
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist ./dist

# Non-root secure user
USER node

# Expose HTTP REST and Socket.IO real-time port
EXPOSE 4040

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4040/health || exit 1

# Launch Fastify backend engine
CMD ["node", "dist/server.js"]
