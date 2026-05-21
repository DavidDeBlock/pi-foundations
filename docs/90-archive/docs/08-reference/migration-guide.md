# Migration Guide

**Last Updated:** 2026-04-18  
**Maintained By:** Architect  
**Status:** 🚧 In Progress  

---

## Purpose

This guide provides instructions for migrating between versions of the project.

---

## Current Version: 1.0.0

No migration needed - this is the initial release.

---

## Future Migrations

### Migration [X.Y.Z] → [A.B.C]

When a new version is released, add migration instructions here.

#### Breaking Changes

List any breaking changes that require manual intervention:

```markdown
### Database Schema Changes

- **Changed**: `todos` table - added `due_date` column
  - Migration: Run `pnpm db:migrate` before starting app
  - Impact: Existing todos will have NULL due_date

### API Changes

- **Removed**: `/api/todos/:id/archive` endpoint
  - Replacement: Use `/api/todos/:id` with `completed: true`
  - Migration: Update frontend calls to use new endpoint

### Dependency Updates

- **Updated**: React from 17.x to 18.x
  - Migration: Review React docs for breaking changes
  - Action: Test all components after upgrade
```

---

## General Migration Process

### Step 1: Read Release Notes

Check the changelog for:
- Breaking changes
- Deprecation notices
- New required configurations

### Step 2: Backup

Before migrating:

```bash
# Backup database
cp server/data/db.sqlite server/data/db.sqlite.backup

# Note current version
git describe --tags
```

### Step 3: Update Dependencies

```bash
# Update package.json versions
pnpm update

# Or force specific versions
pnpm install react@18.2.0
```

### Step 4: Run Migrations

```bash
# Apply database migrations
cd server && pnpm db:migrate

# Run any setup scripts
pnpm migrate:setup
```

### Step 5: Test Thoroughly

```bash
# Run all tests
pnpm test

# Test critical user flows manually
# - Login/registration
# - Main CRUD operations
# - Edge cases mentioned in release notes
```

### Step 6: Deploy to Staging First

Never deploy a migration directly to production. Test on staging first.

---

## Common Migration Scenarios

### Database Schema Changes

**Scenario**: Adding required column to existing table

```sql
-- Migration file: migrations/001_add_required_column.sql
ALTER TABLE todos ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium';
```

**Migration Steps**:
1. Run migration on staging first
2. Verify data integrity
3. Deploy to production during low-traffic window
4. Monitor for errors

### API Breaking Changes

**Scenario**: Removing or changing endpoint structure

**Before**:
```typescript
// Old code
const todo = await apiClient.get(`/api/todos/${id}`);
```

**After**:
```typescript
// New code
const todo = await apiClient.get(`/api/items/${id}`); // Endpoint renamed
```

**Migration Steps**:
1. Update all API calls in codebase
2. Run tests to verify changes work
3. Update documentation
4. Deploy and monitor

### Dependency Upgrades

**Scenario**: Major version upgrade of a dependency

**Before**:
```json
{
  "dependencies": {
    "react": "^17.0.0"
  }
}
```

**After**:
```json
{
  "dependencies": {
    "react": "^18.2.0"
  }
}
```

**Migration Steps**:
1. Read upgrade guide from library maintainers
2. Check for breaking changes in changelog
3. Update package.json
4. Run `pnpm install`
5. Fix any TypeScript errors
6. Test all features thoroughly
7. Deploy to staging first

---

## Rollback Procedures

If a migration causes issues:

### Database Rollback

```bash
# Restore from backup
cp server/data/db.sqlite.backup server/data/db.sqlite

# Or run reverse migration (if available)
cd server && pnpm db:migrate --revert
```

### Code Rollback

```bash
# Checkout previous version
git checkout <previous-tag>

# Redeploy
pnpm build
./scripts/deploy-production.sh
```

---

## Migration Checklist

Before deploying a migration:

- [ ] Read full changelog for breaking changes
- [ ] Document all manual steps required
- [ ] Create database backup
- [ ] Test on staging environment first
- [ ] Verify all tests pass
- [ ] Prepare rollback plan
- [ ] Notify team of deployment window
- [ ] Monitor logs after deployment

---

## Related Documentation

- [Changelog](changelog.md) - Version history
- [Deployment Guide](../04-operations/deployment.md) - Deployment process
- [Tech Stack](tech-stack.md) - Technology versions and updates

---

**Last Updated:** 2026-04-18  
**Review Status:** In Progress  
**Next Review Date:** Per release
