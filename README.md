# SahAI API Gateway: Express.js Microservice

This directory contains the Express.js API Gateway (`sahai-api-node`) for the SahAI platform. It manages student authentication, session provisioning, curriculum state lookups, rate limiting, telemetry security, and proxies telemetry events to the Python inference worker.

---

## 🏗️ Architectural Core

The API Gateway is designed for low-latency request dispatch and security enforcement at the edge:
1. **User Authentication & Session Caching**: Implements custom token authorization using lightweight AES-256-CBC token encryption (zero external token dependencies). Protects all user paths with the `authRequired` middleware.
2. **Zero-Trust Telemetry Decryption**: Intercepts client telemetry payloads at `POST /api/telemetry` using the `decryptTelemetry` middleware. Decrypts client AES-256 encrypted payloads via Node's native `crypto` module, validating inputs against a shared symmetric key before pushing to buffers.
3. **Upstash Redis Rate Limiting**: Intercepts requests using `telemetryRateLimiter`, enforcing a sliding window limit of **1 telemetry submission per 5 seconds** per user ID to block scripting spam.
4. **Data Privacy Compliance (DPDP)**: Strips identifiers (like client-side `user_id` values) from outbound client telemetry. Re-injects the verified, token-extracted student UUID directly in the gateway before transmitting to Redis queues or Python workers.
5. **Static Frontend Provisioning**: Configured to serve the compiled Vite React frontend (`clients/react/dist`) statically from its root Express route in production.
6. **Zero-Idle Queue Trigger**: Connects to the Python engine `/trigger-process-queue` HTTP endpoint synchronously to invoke queue consumption. This avoids continuous polling loops and keeps idle Redis command costs at zero.

---

## 📂 Submodule Directory Layout

* `src/app.js` - Service bootstrapping, middleware declarations, static file serving routes, and diagnostic setups.
* `src/config/` - Dynamic environment parameters loader. Searches for the parent `ENV` directory or reads system variables.
* `src/middleware/` - Custom token validation (`auth.js`), AES payload decryption (`decrypt.js`), and rate limiters (`rateLimiter.js`).
* `src/controllers/` - Endpoint logic handlers (users, curricula, questions, telemetry logs).
* `src/routes/` - REST API gateway routing declarations.
* `src/utils/` - Secure logger that automatically redacts passwords, connection strings, and keys.

---

## 🔌 API Endpoints Reference

### Authentication & Profiles
* `POST /api/user/signup` - Register a new user, hashes password, returns AES encrypted auth token.
* `POST /api/user/login` - Authenticate credentials, returns auth token.
* `POST /api/user/personalize` - Save GATE target papers, curriculum streams, and seed student-specific cognitive graph copies.
* `GET /api/user/profile` - Retrieve authenticated student metadata.
* `GET /api/user/cognitive-state` - Retrieve student mastery values with active `Cache-Control` bypass headers.

### Curriculum & Questions
* `GET /api/curriculum/:domain` - Load dynamic curriculum nodes and prerequisites. Returns global links merged with student-specific masteries.
* `GET /api/question/diagnostic` - Load the 10 timed diagnostic test questions.
* `GET /api/question/practice` - Retrieve recommended practice questions targeting the student's weakest nodes.
* `POST /api/question/submit` - Submit timed MCQ responses, logging results to PostgreSQL and triggering Bayesian updates.

### Telemetry & Diagnostics
* `POST /api/telemetry` - Encrypted, rate-limited telemetry ingestion endpoint.
* `GET /api/diagnose` - Diagnostic helper to check internal DNS resolution (e.g. Railway private routing) and variable scopes.

---

## 🚀 Execution & Deployment Guide

### 1. Requirements
Ensure Node.js 18+ and npm are installed locally.

### 2. Environment Setup
Configure the environment variables in `ENV/.env` (parent directory) or define them in your environment shell:
* `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASSWORD` / `PG_DATABASE` - Supabase Postgres configuration.
* `REDIS_URL` - Upstash Redis queue connector string.
* `ENGINE_PYTHON_URL` - Endpoint to reach the Python worker (default: `http://localhost:5000` or private Railway DNS).
* `VITE_AES_SECRET_KEY` - Symmetric key for decrypting telemetry logs.

### 3. Local Commands
To run the server locally:
```bash
# Install dependencies
npm install

# Start in development mode (hot reloading via nodemon)
npm run dev

# Start in production mode
npm start
```
The gateway will boot and bind to `http://localhost:3000`.
