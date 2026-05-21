# Application Contract Template

**Last Updated:** 2026-04-18  
**Maintained By:** Architect  
**Status:** ✅ Current  

---

## Purpose

Use this template to define application-level contracts at project inception or major redesign. Covers architecture, APIs, security, and operations.

---

# Application Contract: [App Name]

**Version**: 1.0.0  
**Status**: [Draft | Active | Deprecated]  
**Created**: YYYY-MM-DD  
**Last Updated**: YYYY-MM-DD  
**Owner**: [Technical Lead]  

---

## Application Overview

*What is this application? What value does it provide?*

[2-3 paragraph description of the application's purpose, target users, and core value proposition]

---

## System Boundaries

### In Scope
- ✅ Core feature set (list all major features)
- ✅ User authentication & authorization
- ✅ Data persistence layer
- ✅ API endpoints for mobile apps

### Out of Scope
- ❌ Admin dashboard (Phase 2)
- ❌ Mobile native apps (Web only for now)
- ❌ Third-party integrations (planned but not implemented)

---

## Technical Architecture

### High-Level Diagram

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Client    │────▶│  API Server  │────▶│  Database   │
│ (React)     │     │  (Hono)      │     │ (SQLite)    │
└─────────────┘     └──────────────┘     └─────────────┘
       ▶                ▶                  ▶
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Cache     │◀────│  Middleware  │◀────│  Logging    │
│  (Redis)    │     │  (Auth, etc) │     │  (Winston)  │
└─────────────┘     └──────────────┘     └─────────────┘
```

### Technology Stack Summary

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Frontend | React + TypeScript | 18.x + 5.x | SPA with SSR support |
| Backend | Hono | 4.x | Edge-compatible runtime |
| Database | SQLite (sql.js) | - | File-based, no server needed |
| ORM | Drizzle | 0.x | Type-safe queries |
| Auth | JWT + HTTP-only cookies | - | Stateless authentication |

---

## API Contracts

### Authentication Endpoints

| Method | Endpoint | Description | Request | Response |
|--------|----------|-------------|---------|----------|
| POST | `/api/auth/login` | User login | `{email, password}` | `{token, user}` |
| POST | `/api/auth/register` | New user registration | `{email, password, name}` | `{token, user}` |
| GET | `/api/auth/me` | Get current user | (auth header) | `{user}` |

### Core API Endpoints

| Method | Endpoint | Description | Auth | Rate Limit |
|--------|----------|-------------|------|------------|
| GET | `/api/items` | List items | Yes | 100/min |
| POST | `/api/items` | Create item | Yes | 20/min |
| GET | `/api/items/:id` | Get single item | Yes | 100/min |
| PUT | `/api/items/:id` | Update item | Yes | 50/min |
| DELETE | `/api/items/:id` | Delete item | Yes | 20/min |

### Error Response Format

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input data",
    "details": [
      {"field": "email", "message": "Invalid email format"}
    ]
  }
}
```

---

## Data Model

### Core Entities

| Entity | Description | Key Fields | Relationships |
|--------|-------------|------------|---------------|
| User | System user | id, email, name, passwordHash | has many Items |
| Item | Main business entity | id, userId, title, data | belongs to User |

### Database Schema (Drizzle)

```typescript
// server/db/schema.ts
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 100 }),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').$onUpdate(() => new Date()).notNull(),
});

export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  title: varchar('title', { length: 200 }).notNull(),
  data: jsonb('data').$type<ItemData>().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').$onUpdate(() => new Date()).notNull(),
});
```

---

## Security Requirements

### Authentication & Authorization
- JWT tokens stored in HTTP-only cookies
- Token refresh every 15 minutes, absolute expiry 24 hours
- Role-based access control (admin vs user)

### Data Protection
- All passwords hashed with bcrypt (cost factor 12)
- Sensitive data encrypted at rest (if applicable)
- Input validation on all endpoints (Zod schemas)

### Infrastructure Security
- HTTPS required in production
- CORS configured for allowed origins only
- Rate limiting on all public endpoints

---

## Performance Requirements

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| API Response Time (p95) | < 200ms | Load testing with k6 |
| Page Load Time (p95) | < 1s | Lighthouse CI |
| Database Query Time | < 50ms | Query logging |
| Concurrent Users Supported | 1,000 | Stress testing |

---

## Deployment Requirements

### Environments
- **Development**: Local machine or Docker Compose
- **Staging**: Auto-deploy on merge to `main`
- **Production**: Manual approval required, weekly deployment window

### CI/CD Pipeline

```yaml
# .github/workflows/deploy.yml
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm test
  deploy-staging:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: pnpm build
      - run: ./deploy.sh staging
```

---

## Monitoring & Observability

### Logging
- Structured JSON logs with correlation IDs
- Log levels: error, warn, info, debug
- Retention: 30 days in application logs

### Metrics
- Request count and latency (Prometheus)
- Error rates by endpoint
- Database query performance

### Alerts
- Error rate > 1% for 5 minutes → Slack alert
- Response time p95 > 500ms for 10 minutes → Slack alert
- Database connection pool exhausted → PagerDuty alert

---

## Operational Runbooks

### Common Operations

#### Restart Application
```bash
# Production (via deployment system)
./deploy.sh restart production

# Local development
cd server && pnpm dev
```

#### Rotate API Keys
```bash
# Generate new key
openssl rand -base64 32 > .env.new

# Update in deployment config
kubectl set secret api-keys --from-file=.env.new

# Restart pods
kubectl rollout restart deployment/api
```

### Incident Response

| Severity | Response Time | Escalation Path |
|----------|---------------|-----------------|
| P0 (Down) | 5 minutes | On-call → Tech Lead → CTO |
| P1 (Degraded) | 30 minutes | On-call → Tech Lead |
| P2 (Minor) | 4 hours | Next business day |

---

## Version History

| Version | Date | Changes | Owner |
|---------|------|---------|-------|
| 1.0.0 | YYYY-MM-DD | Initial contract | [Name] |

---

**Approval:**  
[ ] Product Owner: __________ Date: _______  
[ ] Architect: __________ Date: _______  
[ ] Security Reviewer: __________ Date: _______
