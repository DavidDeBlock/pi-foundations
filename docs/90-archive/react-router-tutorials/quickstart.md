# Quick Start Tutorial - React Router

**Source:** https://reactrouter.com/tutorials/quickstart  
**Extracted:** 2026-04-18

## Overview

This guide covers the basic plumbing required to run a React Router app. While there are many starter templates available, this tutorial explains everything from scratch.

---

## Installation & Setup

### Prerequisites
Since React Router uses Vite, you'll need to provide a Vite config with the React Router Vite plugin.

### Basic Project Structure

```
├── app/
│   ├── root.jsx      # Root layout of your entire app
│   └── routes.js     # Route definitions (export empty array for minimal setup)
├── package.json
└── vite.config.js    # Vite config with React Router plugin
```

---

## 1. Vite Config

Create `vite.config.js`:

```javascript
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
});
```

---

## 2. The Root Route

`app/root.jsx` is the root layout of your entire app. Basic elements needed for any project:

```jsx
import { Outlet, Scripts } from "react-router";

export default function App() {
  return (
    <html>
      <head>
        <link
          rel="icon"
          href="data:image/x-icon;base64,AA"
        />
      </head>
      <body>
        <h1>Hello world!</h1>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
```

---

## 3. Additional Routes

`app/routes.js` is where you define your routes:

```javascript
export default [];
```

The existence of `routes.js` is required to build a React Router app. You can read more about defining routes in the Routing guide.

**Note:** Specify `"type": "module"` in package.json for ES module requirements.

---

## 4. Build and Run

### Initial Setup Commands

```bash
mkdir my-react-router-app
cd my-react-router-app
npm init -y

# Install runtime dependencies
npm i react-router @react-router/node @react-router/serve isbot react react-dom

# Install dev dependencies
npm i -D @react-router/dev vite

npm pkg set type="module"
```

### Build for Production

```bash
npx react-router build
```

This creates a `build` folder containing:
- `build/server/` - Server version of your app
- `build/client/` - Browser version with build artifacts

### Run with react-router-serve

```bash
npx react-router-serve build/server/index.js
```

Open http://localhost:3000 to see the "hello world" page.

---

## 5. Bring Your Own Server

React Router is designed to run in any JavaScript environment (Express, Cloudflare Workers, Netlify, Vercel, Fastly, AWS, Deno, Azure, Fastify, Firebase, etc.).

### Install Express and Adapters

```bash
npm i express @react-router/express cross-env
npm uninstall @react-router/serve  # Not needed anymore
```

### Create an Express Server (`server.js`)

```javascript
import { createRequestHandler } from "@react-router/express";
import express from "express";

const app = express();
app.use(express.static("build/client"));

// Your app is "just a request handler"
app.use(
  createRequestHandler({
    // The result of `react-router build` is "just a module"
    build: await import("./build/server/index.js"),
  }),
);

app.listen(3000, () => {
  console.log("App listening on http://localhost:3000");
});
```

### Run Your App with Express

```bash
node server.js
```

**Debugging:** Use Node.js inspect flag for Chrome DevTools:
```bash
node --inspect server.js
```

---

## 6. Development Workflow

Use Vite in middleware mode for instant feedback with React Refresh (HMR) and React Router Hot Data Revalidation.

### Add Scripts to package.json

```json
{
  "scripts": {
    "dev": "node ./server.js",
    "start": "cross-env NODE_ENV=production node ./server.js"
  }
}
```

### Add Vite Development Middleware to Server

```javascript
import { createRequestHandler } from "@react-router/express";
import express from "express";

const app = express();

if (process.env.NODE_ENV === "production") {
  app.use(express.static("build/client"));
  app.use(
    createRequestHandler({
      build: await import("./build/server/index.js"),
    }),
  );
} else {
  const viteDevServer = await import("vite").then((vite) =>
    vite.createServer({
      server: { middlewareMode: true },
    }),
  );
  app.use(viteDevServer.middlewares);
  app.use(
    createRequestHandler({
      build: () =>
        viteDevServer.ssrLoadModule("virtual:react-router/server-build"),
    }),
  );
}

app.listen(3000, () => {
  console.log(`Server is running on http://localhost:3000`);
});
```

Run development server:
```bash
npm run dev
```

Now you can work with immediate feedback. Changes in `root.jsx` appear instantly!

---

## 7. Controlling Server and Browser Entries

React Router uses default magic files that most apps don't need to modify. To customize entry points, run:

```bash
npx react-router reveal
```

This creates:
- `app/entry.client.tsx` - Client-side entry point
- `app/entry.server.tsx` - Server-side entry point

---

## Summary

### Key Takeaways

**React Router is "guts out"** - It requires a few minutes of boilerplate, but you own your stack.

**Framework Mode Compiles Your App Into:**
1. A request handler that you add to your own JavaScript server
2. A pile of static assets in your public directory for the browser

**Benefits:**
- ✅ Bring your own server with adapters - deploy anywhere
- ✅ Set up development workflow with HMR built-in
- ✅ Full control over your stack

---

## Next Steps

Initialize a batteries-included project:

```bash
npx create-react-router@latest
```

Or explore more advanced features in the Address Book tutorial.
