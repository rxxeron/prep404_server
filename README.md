# Prep404 Core Server

High-performance real-time backend API, WebSocket duel matchmaking engine, and admission exam platform for **Prep404 • Failure Not Found**.

## Features
- **Fastify HTTP API**: Modular, schemas-validated REST endpoints for admissions, universities, questions, exams, profiles, and streaks.
- **WebSocket Battle Gateway**: Head-to-head 1v1 live matchmaking with Redis Pub/Sub, live round timers, and anti-cheat validation.
- **Athena Analytics & Retention**: Automated learner retention tracking and question mastery models.
- **PostgreSQL & Supabase**: Row Level Security (RLS) enforcement, database migrations, and cached university blueprints.
- **OpenAPI v3 Spec**: Automatic Swagger documentation available at `/docs` and `/api/v1/openapi.json`.

## Tech Stack
- **Runtime**: Node.js 20+, TypeScript
- **Web Framework**: Fastify v5
- **Real-Time Gateway**: `ws` (WebSocket) with Redis Pub/Sub
- **Database**: PostgreSQL (`pg`), Supabase Auth
- **Cache/Queue**: Redis (ioredis) with in-memory fallback

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Ensure `DATABASE_URL` (PostgreSQL), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `REDIS_URL` are configured.

### 3. Run Development Server
```bash
npm run dev
```
The server will start listening on port `4040` (or `process.env.PORT`).

### 4. Build for Production
```bash
npm run build
npm start
```
