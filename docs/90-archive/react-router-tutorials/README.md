# React Router Tutorials Documentation

**Collection of extracted React Router tutorial content**  
**Source:** https://reactrouter.com/tutorials/  
**Extraction Date:** 2026-04-18

---

## Overview

This documentation contains comprehensive tutorials for learning React Router, covering everything from basic setup to advanced features like data loading, mutations, and optimistic UI.

---

## Available Tutorials

### 1. Quick Start Tutorial
**File:** [`quickstart.md`](./quickstart.md)  
**URL:** https://reactrouter.com/tutorials/quickstart

**What you'll learn:**
- Basic project setup with Vite
- Root route configuration
- Route definitions
- Build and run process
- Custom server integration (Express, etc.)
- Development workflow with HMR
- Entry point customization

**Best for:** Beginners who want to understand the fundamentals of React Router setup.

---

### 2. Address Book Tutorial
**File:** [`address-book.md`](./address-book.md)  
**URL:** https://reactrouter.com/tutorials/address-book

**What you'll learn:**
- Complete CRUD application (Create, Read, Update, Delete)
- Nested routes and outlets
- Client-side vs server-side routing
- Data loading with loaders (`clientLoader` / `loader`)
- Type safety with auto-generated TypeScript types
- Layout routes for shared UI components
- Pre-rendering static pages at build time
- Server-side rendering (SSR) configuration
- URL parameters in loaders
- Form-based data mutations with actions
- Redirects after mutations
- Active link styling with NavLink
- Global pending UI states
- Search functionality with URLSearchParams
- History stack management
- Non-navigating fetchers (`useFetcher`)
- Optimistic UI updates

**Best for:** Developers who want to learn advanced React Router features through a complete, working example.

---

## Key Concepts Covered

### Routing Fundamentals
- **Route Configuration** - Define routes in `routes.ts` or file-based routing
- **Dynamic Segments** - Use `:paramName` for URL parameters
- **Nested Routes** - Parent/child relationships with `<Outlet />`
- **Index Routes** - Default child route when no children match

### Data Loading
- **clientLoader** - Client-side data fetching (SPA mode)
- **loader** - Server-side data fetching (SSR mode)
- **Automatic Revalidation** - Data refreshes after mutations
- **Type Safety** - Auto-generated TypeScript types from routes

### Form Handling & Mutations
- **Form Component** - HTML form emulation with actions
- **action Function** - Handle POST/PUT/PATCH/DELETE requests
- **FormData** - Access form data via `request.formData()`
- **redirect()** - Navigate after mutations

### Navigation
- **Link Component** - Client-side navigation without page reloads
- **NavLink Component** - Link with active/pending state detection
- **useNavigate Hook** - Programmatic navigation
- **useSubmit Hook** - Manual form submission

### Advanced Features
- **Layout Routes** - Scoped layouts for route groups
- **Pre-rendering** - Static HTML generation at build time
- **SSR Configuration** - Toggle between client and server rendering
- **useFetcher Hook** - Non-navigating data fetchers
- **Optimistic UI** - Update UI before server confirmation

---

## Project Structure Reference

### Minimal Setup (Quick Start)
```
my-react-router-app/
├── app/
│   ├── root.jsx          # Root layout with Outlet, Scripts
│   └── routes.js         # Route definitions (export [])
├── build/
│   ├── server/           # Server-side build output
│   └── client/           # Static assets for browser
├── package.json
└── vite.config.js        # Vite config with reactRouter plugin
```

### Address Book App Structure
```
app/
├── root.tsx              # Root route (Layout, ErrorBoundary)
├── routes/
│   ├── home.tsx          # Index route (/)
│   ├── contact.tsx       # Dynamic route (/contacts/:contactId)
│   ├── edit-contact.tsx  # Edit form (/contacts/:contactId/edit)
│   └── destroy-contact.tsx # Delete action (/contacts/:contactId/destroy)
├── layouts/
│   └── sidebar.tsx       # Layout with contacts list and search
└── data.ts               # Mock data functions (getContacts, etc.)

react-router.config.ts    # SSR, prerender configuration
```

---

## Common Commands

### Project Initialization
```bash
# Create new project
npx create-react-router@latest

# Or with specific template
npx create-react-router@latest --template remix-run/react-router/tutorials/address-book
```

### Development & Build
```bash
npm install
npm run dev        # Development mode with HMR
npm run build      # Production build
npm run preview    # Preview production build
```

### Server Setup
```bash
# With react-router-serve (simple)
npx react-router-serve build/server/index.js

# Custom Express server
node server.js

# Debug mode
node --inspect server.js
```

---

## Resources

- **Official Documentation:** https://reactrouter.com
- **Quick Start Guide:** https://reactrouter.com/tutorials/quickstart
- **Address Book Tutorial:** https://reactrouter.com/tutorials/address-book
- **GitHub Repository:** https://github.com/remix-run/react-router

---

## Notes

This documentation was extracted from the official React Router tutorials using browser automation. All content is property of React Router and its maintainers. Use this as a reference for learning purposes.

For the most up-to-date information, always refer to the [official documentation](https://reactrouter.com).
