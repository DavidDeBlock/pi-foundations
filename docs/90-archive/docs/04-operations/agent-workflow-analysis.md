# Development Workflow Guide

**Last Updated:** 2026-04-18  
**Maintained By:** Development Team  
**Status:** ✅ Current  

---

## Purpose

This guide covers the complete local development workflow, from setting up your environment to submitting code changes.

---

## Daily Development Flow

### Standard Workflow

```bash
# 1. Start fresh (optional but recommended)
git pull origin main
pnpm install

# 2. Create feature branch
git checkout -b feat/my-feature-name

# 3. Make changes
# Edit files, run tests, iterate...

# 4. Test before committing
pnpm test

# 5. Commit with descriptive message
git add .
git commit -m "feat(my-feature): implement user login"

# 6. Push and create PR
git push origin feat/my-feature-name
```

---

## Development Commands

### Starting Servers

**Option A: Start both at once (recommended)**

```bash
pnpm dev
```

This starts:
- Frontend on http://localhost:5173
- Backend on http://localhost:3000

**Option B: Start separately**

```bash
# Terminal 1 - Frontend only
cd client && pnpm dev

# Terminal 2 - Backend only  
cd server && pnpm dev
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode (re-run on file changes)
pnpm test --watch

# Run specific test file
pnpm test features/todo/services/todo.service.test.ts

# Run with coverage report
pnpm test --coverage
```

### Code Quality Checks

```bash
# Lint all code
pnpm lint

# Format code (auto-fixable issues)
pnpm format

# Type check without running tests
pnpm type-check
```

### Building for Production

```bash
# Build both client and server
pnpm build

# Preview production build locally
pnpm preview
```

---

## File Organization

### Frontend Structure

```
client/src/
├── app/                    # App configuration
│   ├── router.tsx         # Route registry
│   └── store.ts           # Root store (if needed)
├── components/             # Shared UI primitives
│   ├── ui/                # Atomic components
│   └── layout/            # Layout wrappers
├── features/               # Feature modules ⭐
│   └── todo/              # Self-contained feature
│       ├── components/    # Feature-specific UI
│       ├── hooks/         # Custom hooks (if needed)
│       ├── services/      # API calls
│       └── store.ts       # Zustand slice (if needed)
├── pages/                  # Simple route views
└── shared/                # Cross-cutting concerns
    ├── lib/               # Utilities
    ├── types/             # Type definitions
    └── validations/       # Shared validation schemas
```

### Backend Structure

```
server/src/
├── api/                    # API endpoint handlers (Hono routes)
│   └── todos.ts           # Todo CRUD endpoints
├── db/                     # Database configuration
│   ├── schema.ts          # Table definitions
│   └── index.ts           # DB initialization
└── app.ts                  # Hono app setup
```

---

## Making Changes

### Adding a New Feature

1. **Create feature folder**: `features/[feature-name]/`
2. **Define types**: Add to `shared/types/` or feature-specific types
3. **Create validation schemas**: `features/[name]/validations/`
4. **Implement service layer**: `features/[name]/services/`
5. **Add UI components**: `features/[name]/components/`
6. **Define routes**: `features/[name]/routes.tsx` (frontend) + `server/src/routes/` (backend)
7. **Write tests**: `features/__tests__/`

### Modifying Existing Feature

1. Navigate to feature folder: `cd features/todo/`
2. Make changes to relevant files
3. Run tests: `pnpm test features/todo/`
4. Verify no breaking changes to public API

---

## Hot Reload Behavior

### Frontend (Vite)

- ✅ Component changes → Instant update in browser
- ✅ CSS changes → Instant update
- ❌ TypeScript type changes → May need manual refresh
- ⚠️ Route changes → May need manual navigation refresh

### Backend (Hono)

- ✅ Handler changes → Auto-restart server
- ✅ Service changes → Auto-reload on next request
- ❌ Database schema changes → Manual restart required

---

## Debugging Tips

### Frontend Debugging

```typescript
// Use React DevTools browser extension
// Add console logs (remove before commit):
console.log('State:', state);
console.log('Props:', props);

// Set breakpoints in VS Code debugger
// F5 to launch with debugger attached
```

### Backend Debugging

```typescript
// Add logging in route handlers:
logger.info({ userId, action: 'createTodo' });

// Use debugger statements:
debugger; // Breaks execution at this line

// Check database queries:
console.log('Query:', sql);
console.log('Params:', params);
```

### Network Debugging

1. Open browser DevTools → Network tab
2. Filter by API calls (`/api/`)
3. Inspect request/response payloads
4. Check for CORS errors in Console tab

---

## Common Issues & Solutions

### Issue: Port Already in Use

```bash
# Find process using port 5173 (frontend)
lsof -ti:5173

# Kill the process
lsof -ti:5173 | xargs kill

# Same for backend port 3000
lsof -ti:3000 | xargs kill
```

### Issue: TypeScript Errors After Pull

```bash
# Clear TypeScript cache
rm -rf .tsbuildinfo

# Reinstall dependencies
pnpm install

# Regenerate types
pnpm exec tsc --noEmit
```

### Issue: Database Not Found

```bash
# Create data directory if missing
mkdir -p server/data

# Initialize database (if needed)
cd server && pnpm db:init

# Check file permissions
ls -la server/data/db.sqlite
chmod 666 server/data/db.sqlite  # If permission denied
```

### Issue: ESLint Errors on Commit

```bash
# Auto-fix linting issues
pnpm format

# Or fix manually, then commit
git add .
git commit -m "fix: resolve linting errors"
```

---

## Git Best Practices

### Commit Message Format

```bash
# Type(scope): description

# Types:
feat:     New feature
fix:      Bug fix
docs:     Documentation changes
style:    Code style (formatting, etc.)
refactor: Refactoring without behavior change
test:     Adding/updating tests
chore:    Build process or tools

# Examples:
feat(todos): add delete functionality with confirmation dialog
fix(api): handle null response from todo service
docs(conventions): update ADR writing guidelines
```

### Branch Strategy

```bash
# Main branch (protected)
git checkout main
git pull origin main

# Feature branches (from main)
git checkout -b feat/new-feature

# Hotfix branches (from main)
git checkout -b hotfix/critical-bug

# Release branches (from main)
git checkout -b release/1.0.0
```

### Before Pushing

```bash
# Ensure tests pass
pnpm test

# Fix linting issues
pnpm lint --fix

# Check for uncommitted changes
git status

# Review your commits
git log --oneline -5
```

---

## Code Review Process

### What to Include in PR

1. **Clear description**: What changed and why
2. **Screenshots**: For UI changes
3. **Test coverage**: New tests for new functionality
4. **Self-review checklist**: Completed before submitting

### Review Checklist

- [ ] Tests added/updated
- [ ] Code follows conventions
- [ ] Documentation updated (if needed)
- [ ] No console.log in production code
- [ ] Error handling implemented
- [ ] Loading states for async operations
- [ ] Accessibility considerations addressed

---

## Environment Variables

### Frontend (.env)

```bash
# client/.env
VITE_API_URL=http://localhost:3000
```

### Backend (.env)

```bash
# server/.env
DATABASE_PATH=./data/db.sqlite
JWT_SECRET=your-secret-key-change-in-production
NODE_ENV=development
PORT=3000
```

### Adding New Environment Variables

1. Add to `.env.example` (template for new developers)
2. Update `.env` files with values
3. Document in [`../08-reference/tech-stack.md`](../08-reference/tech-stack.md) if relevant

---

## Performance Tips

### Development Optimization

- Use `pnpm dev` instead of building every time
- Enable Vite's fast HMR (hot module replacement)
- Keep feature folders small and focused
- Lazy load routes with `React.lazy()`

### Build Optimization

```bash
# Production build with optimizations
pnpm build --mode production

# Analyze bundle size
pnpm build --analyze
```

---

## Next Steps

After completing development workflow:

1. ✅ Read [`testing.md`](testing.md) for testing strategy
2. ✅ Review [`deployment.md`](deployment.md) for deployment process
3. ✅ Check [`troubleshooting.md`](troubleshooting.md) for common issues
4. ✅ Make your first feature and submit a PR

---

**Last Updated:** 2026-04-18  
**Review Status:** Active  
**Next Review Date:** 2026-05-18
