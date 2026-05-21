# Address Book Tutorial - React Router

**Source:** https://reactrouter.com/tutorials/address-book  
**Extracted:** 2026-04-18  
**Estimated Time:** 30-45 minutes

## Overview

Build a small, feature-rich address book app that lets you keep track of contacts. No database or production-ready features - just focus on React Router's capabilities.

---

## Table of Contents

1. [Setup](#setup)
2. [The Root Route](#the-root-route)
3. [The Contact Route UI](#the-contact-route-ui)
4. [Nested Routes and Outlets](#nested-routes-and-outlets)
5. [Client Side Routing](#client-side-routing)
6. [Loading Data](#loading-data)
7. [Type Safety](#type-safety)
8. [Adding a HydrateFallback](#adding-a-hydratefallback)
9. [Index Routes](#index-routes)
10. [Adding an About Route](#adding-an-about-route)
11. [Layout Routes](#layout-routes)
12. [Pre-rendering a Static Route](#pre-rendering-a-static-route)
13. [Server-Side Rendering](#server-side-rendering)
14. [URL Params in Loaders](#url-params-in-loaders)
15. [Throwing Responses](#throwing-responses)
16. [Data Mutations](#data-mutations)
17. [Creating Contacts](#creating-contacts)
18. [Updating Data](#updating-data)
19. [Updating Contacts with FormData](#updating-contacts-with-formdata)
20. [Mutation Discussion](#mutation-discussion)
21. [Redirecting new records to the edit page](#redirecting-new-records-to-the-edit-page)
22. [Active Link Styling](#active-link-styling)
23. [Global Pending UI](#global-pending-ui)
24. [Deleting Records](#deleting-records)
25. [Cancel Button](#cancel-button)
26. [URLSearchParams and GET Submissions](#urlsearchparams-and-get-submissions)
27. [Synchronizing URLs to Form State](#synchronizing-urls-to-form-state)
28. [Submitting Form's onChange](#submitting-forms-onchange)
29. [Adding Search Spinner](#adding-search-spinner)
30. [Managing the History Stack](#managing-the-history-stack)
31. [Forms Without Navigation](#forms-without-navigation)
32. [Optimistic UI](#optimistic-ui)

---

## Setup

### Generate a Basic Template

```bash
npx create-react-router@latest --template remix-run/react-router/tutorials/address-book
cd {wherever you put the app}
npm install
npm run dev
```

Open http://localhost:5173 to see your app running.

**Note:** `app/root.tsx` is called the "Root Route" - it's the first component that renders, containing the global layout and default Error Boundary.

---

## The Root Route

The root route contains the document structure with Layout export for the app shell:

```tsx
import {
  Form,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from "react-router";
import type { Route } from "./+types/root";
import appStylesHref from "./app.css?url";

export default function App() {
  return (
    <>
      <div id="sidebar">
        <h1>React Router Contacts</h1>
        <div>
          <Form id="search-form" role="search">
            <input
              aria-label="Search contacts"
              id="q"
              name="q"
              placeholder="Search"
              type="search"
            />
            <div
              aria-hidden
              hidden={true}
              id="search-spinner"
            />
          </Form>
          <Form method="post">
            <button type="submit">New</button>
          </Form>
        </div>
        <nav>
          <ul>
            <li><a href={`/contacts/1`}>Your Name</a></li>
            <li><a href={`/contacts/2`}>Your Friend</a></li>
          </ul>
        </nav>
      </div>
    </>
  );
}

// Layout export - acts as document's "app shell"
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href={appStylesHref} />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// ErrorBoundary - top most error handler
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main id="error-page">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && <pre><code>{stack}</code></pre>}
    </main>
  );
}
```

---

## The Contact Route UI

Create a route for `/contacts/1`:

### Create Contact Route Module

```bash
mkdir app/routes
touch app/routes/contact.tsx
```

```tsx
import { Form } from "react-router";
import type { ContactRecord } from "../data";

export default function Contact() {
  const contact = {
    first: "Your",
    last: "Name",
    avatar: "https://placecats.com/200/200",
    twitter: "your_handle",
    notes: "Some notes",
    favorite: true,
  };

  return (
    <div id="contact">
      <div>
        <img
          alt={`${contact.first} ${contact.last} avatar`}
          key={contact.avatar}
          src={contact.avatar}
        />
      </div>
      <div>
        <h1>
          {contact.first || contact.last ? (
            <>
              {contact.first} {contact.last}
            </>
          ) : (
            <i>No Name</i>
          )}
          <Favorite contact={contact} />
        </h1>
        {contact.twitter && (
          <p><a href={`https://twitter.com/${contact.twitter}`}>{contact.twitter}</a></p>
        )}
        {contact.notes && <p>{contact.notes}</p>}
        <div>
          <Form action="edit"><button type="submit">Edit</button></Form>
          <Form action="destroy" method="post" onSubmit={(event) => {
            const response = confirm("Please confirm you want to delete this record.");
            if (!response) event.preventDefault();
          }}>
            <button type="submit">Delete</button>
          </Form>
        </div>
      </div>
    </div>
  );
}

function Favorite({ contact }: { contact: Pick<ContactRecord, "favorite"> }) {
  const favorite = contact.favorite;
  return (
    <Form method="post">
      <button
        aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
        name="favorite"
        value={favorite ? "false" : "true"}
      >
        {favorite ? "★" : "☆"}
      </button>
    </Form>
  );
}
```

### Configure the Route

`app/routes.ts`:
```tsx
import type { RouteConfig } from "@react-router/dev/routes";
import { route } from "@react-router/dev/routes";

export default [
  route("contacts/:contactId", "routes/contact.tsx"),
] satisfies RouteConfig;
```

This makes URLs like `/contacts/123` and `/contacts/abc` match the contact route.

---

## Nested Routes and Outlets

React Router supports nested routing. Render an `<Outlet />` in the parent:

```tsx
import { Form, Outlet } from "react-router";

export default function App() {
  return (
    <>
      <div id="sidebar">{/* other elements */}</div>
      <div id="detail">
        <Outlet />
      </div>
    </>
  );
}
```

---

## Client Side Routing

Change sidebar `<a href>` to `<Link to>` for client-side routing:

```tsx
import { Link } from "react-router";

<Link to={`/contacts/1`}>Your Name</Link>
```

This prevents full document requests and remounting the app.

---

## Loading Data

### Export a clientLoader Function

```tsx
// existing imports
import { getContacts } from "./data";

export async function clientLoader() {
  const contacts = await getContacts();
  return { contacts };
}

export default function App({ loaderData }: Route.ComponentProps) {
  const { contacts } = loaderData;
  // ... render contacts in sidebar
}
```

React Router automatically keeps data in sync with your UI.

---

## Type Safety

React Router generates types for each route:

```tsx
export default function App({
  loaderData,
}: Route.ComponentProps) {
  const { contacts } = loaderData;
  // TypeScript knows about the contacts property!
}
```

Check `react-router.config.ts`:
```tsx
import { type Config } from "@react-router/dev/config";

export default {
  ssr: false,  // Single Page App mode
} satisfies Config;
```

---

## Adding a HydrateFallback

Add loading splash before client hydration:

```tsx
export function HydrateFallback() {
  return (
    <div id="loading-splash">
      <div id="loading-splash-spinner" />
      <p>Loading, please wait...</p>
    </div>
  );
}
```

---

## Index Routes

When a route has children and you're at the parent path, `<Outlet>` renders nothing. Create an index route:

```tsx
touch app/routes/home.tsx
```

`app/routes.ts`:
```tsx
import { index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("contacts/:contactId", "routes/contact.tsx"),
] satisfies RouteConfig;
```

---

## Adding an About Route

### Create the About Route

```tsx
touch app/routes/about.tsx
```

`app/routes.ts`:
```tsx
export default [
  index("routes/home.tsx"),
  route("contacts/:contactId", "routes/contact.tsx"),
  route("about", "routes/about.tsx"),
] satisfies RouteConfig;
```

```tsx
import { Link } from "react-router";

export default function About() {
  return (
    <div id="about">
      <Link to="/">← Go to demo</Link>
      <h1>About React Router Contacts</h1>
      <p>This is a demo application showing off some of the powerful features...</p>
    </div>
  );
}
```

---

## Layout Routes

Move sidebar to a layout route:

```tsx
mkdir app/layouts
touch app/layouts/sidebar.tsx
```

`app/layouts/sidebar.tsx`:
```tsx
import { Outlet } from "react-router";

export default function SidebarLayout() {
  return <Outlet />;
}
```

### Move Route Definitions Under Layout

```tsx
import { index, layout, route } from "@react-router/dev/routes";

export default [
  layout("layouts/sidebar.tsx", [
    index("routes/home.tsx"),
    route("contacts/:contactId", "routes/contact.tsx"),
  ]),
  route("about", "routes/about.tsx"),
] satisfies RouteConfig;
```

### Move Layout and Data Fetching to Sidebar Layout

`app/layouts/sidebar.tsx`:
```tsx
import { Form, Link, Outlet } from "react-router";
import { getContacts } from "../data";
import type { Route } from "./+types/sidebar";

export async function clientLoader() {
  const contacts = await getContacts();
  return { contacts };
}

export default function SidebarLayout({ loaderData }: Route.ComponentProps) {
  const { contacts } = loaderData;
  // ... render sidebar with contacts list
  return (
    <>
      <div id="sidebar">...</div>
      <div id="detail"><Outlet /></div>
    </>
  );
}
```

`app/root.tsx`:
```tsx
export default function App() {
  return <Outlet />;
}
// Remove clientLoader and unused imports
```

---

## Pre-rendering a Static Route

Pre-render the about page at build time:

```tsx
import { type Config } from "@react-router/dev/config";

export default {
  ssr: false,
  prerender: ["/about"],
} satisfies Config;
```

Now refreshing the about page won't show a loading spinner!

---

## Server-Side Rendering

Enable SSR by setting `ssr: true`:

```tsx
export default {
  ssr: true,
  prerender: ["/about"],
} satisfies Config;
```

Switch from `clientLoader` to `loader`:

```tsx
// In sidebar.tsx
export async function loader() {
  const contacts = await getContacts();
  return { contacts };
}
```

---

## URL Params in Loaders

Dynamic segments like `:contactId` match changing values in the URL. These params are passed to loaders:

```tsx
// In contact.tsx
import { getContact } from "../data";
import type { Route } from "./+types/contact";

export async function loader({ params }: Route.LoaderArgs) {
  const contact = await getContact(params.contactId);
  return { contact };
}

export default function Contact({ loaderData }: Route.ComponentProps) {
  const { contact } = loaderData;
  // ... render contact details
}
```

---

## Throwing Responses

Handle not found contacts with proper 404:

```tsx
export async function loader({ params }: Route.LoaderArgs) {
  const contact = await getContact(params.contactId);
  if (!contact) {
    throw new Response("Not Found", { status: 404 });
  }
  return { contact };
}
```

Components can focus on the happy path! 😁

---

## Data Mutations

React Router emulates HTML Form navigation as the data mutation primitive. Forms cause navigation like links, but can also change request method (GET vs POST) and body (form data).

### Creating Contacts

Export an action function in root route:

```tsx
import { createEmptyContact } from "./data";

export async function action() {
  const contact = await createEmptyContact();
  return { contact };
}
```

Clicking "New" button creates a new record and sidebar updates automatically!

**Why it works:** `<Form>` prevents browser from sending request to server, sends it to route's action with fetch. POST means data is changing, so React Router automatically revalidates data after action finishes.

---

## Updating Data

### Create Edit Contact Route

```tsx
touch app/routes/edit-contact.tsx
```

`app/routes.ts`:
```tsx
export default [
  layout("layouts/sidebar.tsx", [
    index("routes/home.tsx"),
    route("contacts/:contactId", "routes/contact.tsx"),
    route("contacts/:contactId/edit", "routes/edit-contact.tsx"),
  ]),
  route("about", "routes/about.tsx"),
] satisfies RouteConfig;
```

### Add Edit Page UI

```tsx
import { Form } from "react-router";
import type { Route } from "./+types/edit-contact";
import { getContact } from "../data";

export async function loader({ params }: Route.LoaderArgs) {
  const contact = await getContact(params.contactId);
  if (!contact) throw new Response("Not Found", { status: 404 });
  return { contact };
}

export default function EditContact({ loaderData }: Route.ComponentProps) {
  const { contact } = loaderData;

  return (
    <Form key={contact.id} id="contact-form" method="post">
      <p>
        <span>Name</span>
        <input aria-label="First name" defaultValue={contact.first} name="first" placeholder="First" type="text" />
        <input aria-label="Last name" defaultValue={contact.last} name="last" placeholder="Last" type="text" />
      </p>
      <label>
        <span>Twitter</span>
        <input defaultValue={contact.twitter} name="twitter" placeholder="@jack" type="text" />
      </label>
      <label>
        <span>Avatar URL</span>
        <input aria-label="Avatar URL" defaultValue={contact.avatar} name="avatar" placeholder="https://example.com/avatar.jpg" type="text" />
      </label>
      <label>
        <span>Notes</span>
        <textarea defaultValue={contact.notes} name="notes" rows={6} />
      </label>
      <p>
        <button type="submit">Save</button>
        <button type="button">Cancel</button>
      </p>
    </Form>
  );
}
```

### Add Action Function to Edit Route

```tsx
import { Form, redirect } from "react-router";
import { getContact, updateContact } from "../data";

export async function action({ params, request }: Route.ActionArgs) {
  const formData = await request.formData();
  const updates = Object.fromEntries(formData);
  await updateContact(params.contactId, updates);
  return redirect(`/contacts/${params.contactId}`);
}
```

**FormData handling:** Each form field with a `name` attribute is accessible via `formData.get(name)`. Use `Object.fromEntries(formData)` to collect all fields.

---

## Mutation Discussion

After action completes, the redirect tells the app to change locations:

```tsx
return redirect(`/contacts/${params.contactId}`);
```

- Without JavaScript: Normal server redirect (fetches latest data)
- With JavaScript: Client-side redirect (preserves scroll position and component state)

The sidebar automatically updates because React Router revalidates all data after action calls.

---

## Redirecting new records to the edit page

Update create contact action to redirect:

```tsx
export async function action() {
  const contact = await createEmptyContact();
  return redirect(`/contacts/${contact.id}/edit`);
}
```

Now clicking "New" takes you directly to the edit page.

---

## Active Link Styling

Replace `<Link>` with `<NavLink>` for active state styling:

```tsx
import { NavLink } from "react-router";

<NavLink
  className={({ isActive, isPending }) =>
    isActive ? "active" : isPending ? "pending" : ""
  }
  to={`contacts/${contact.id}`}
>
  {/* contact name */}
</NavLink>
```

- `isActive`: User is at the matching URL
- `isPending`: Data is still loading for this link

---

## Global Pending UI

Use `useNavigation` hook for loading feedback:

```tsx
import { useNavigation } from "react-router";

export default function SidebarLayout({ loaderData }: Route.ComponentProps) {
  const { contacts } = loaderData;
  const navigation = useNavigation();

  return (
    <>
      <div className={navigation.state === "loading" ? "loading" : ""} id="detail">
        <Outlet />
      </div>
    </>
  );
}
```

`useNavigation` returns state: `"idle"`, `"loading"`, or `"submitting"`.

---

## Deleting Records

### Configure Destroy Route Module

```tsx
touch app/routes/destroy-contact.tsx
```

Add to routes:
```tsx
route("contacts/:contactId/destroy", "routes/destroy-contact.tsx")
```

### Add Destroy Action

```tsx
import { deleteContact } from "../data";

export async function action({ params }: Route.ActionArgs) {
  await deleteContact(params.contactId);
  return redirect("/");
}
```

Delete button uses relative form action:
```tsx
<Form action="destroy" method="post">...</Form>
```

---

## Cancel Button

Add cancel button with `useNavigate`:

```tsx
import { useNavigate } from "react-router";

<button type="button" onClick={() => navigate(-1)}>Cancel</button>
```

**Note:** `<button type="button">` prevents form submission (HTML standard).

---

## URLSearchParams and GET Submissions

Search field is a mix: it's a form but only changes the URL, not data.

Submit search form → URL contains query as `URLSearchParams`:
```
/?q=alex
```

Filter list in loader using search params:
```tsx
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // ... filter contacts based on q
}
```

---

## Synchronizing URLs to Form State

### Return q from Loader

```tsx
return { q };
```

Set input's default value:
```tsx
<input defaultValue={loaderData.q} name="q" />
```

### Sync Input Value with URLSearchParams

Use `useEffect` to manipulate DOM directly:
```tsx
import { useEffect } from "react";
import { useLoaderData, useNavigation } from "react-router";

const input = document.getElementById("q") as HTMLInputElement;
useEffect(() => {
  if (navigation.location) {
    const q = new URL(navigation.location).searchParams.get("q");
    if (input.value !== q) input.value = q || "";
  }
}, [navigation.location]);
```

---

## Submitting Form's onChange

Use `useSubmit` for real-time search:

```tsx
import { useSubmit } from "react-router";

const submit = useSubmit();
<input
  onChange={(event) => submit(event.currentTarget)}
  name="q"
/>
```

As you type, the form is automatically submitted!

---

## Adding Search Spinner

Add loading indicator for search:

```tsx
import { useNavigation } from "react-router";

const navigation = useNavigation();
const searching = navigation.location && new URL(navigation.location).searchParams.get("q");

<div className={searching ? "searching" : ""}>
  <input name="q" />
</div>
```

CSS:
```css
#search-spinner {
  display: none;
}
.searching #search-spinner {
  display: block;
}
```

---

## Managing the History Stack

Avoid history stack bloat from every keystroke:

```tsx
import { useNavigation, useSubmit } from "react-router";

const submit = useSubmit();
const navigation = useNavigation();

onChange={(event) => {
  const isFirstSearch = !navigation.location;
  submit(event.currentTarget, {
    replace: !isFirstSearch,  // Replace instead of push after first search
  });
}}
```

Now users only have to click back once to remove the search.

---

## Forms Without Navigation

Use `useFetcher` for actions without navigation:

### Change Favorite Form to Fetcher Form

```tsx
import { useFetcher } from "react-router";

const fetcher = useFetcher();

<fetcher.Form method="post">
  <button name="favorite" value={false}>★</button>
</fetcher.Form>
```

Create the action:
```tsx
export async function action({ request, params }: Route.ActionArgs) {
  const formData = await request.formData();
  // ... update favorite status
}
```

**Key difference:** Not a navigation, so URL doesn't change and history stack is unaffected.

---

## Optimistic UI

Update UI immediately using `fetcher.formData`:

```tsx
const fetcher = useFetcher();
const isFavorite = fetcher.formData?.get("favorite") === "true" || contact.favorite;

<button name="favorite" value={false}>
  {isFavorite ? "★" : "☆"}
</button>
```

The star immediately changes when clicked. If the update fails, UI reverts to real data.

---

## Summary

### Key APIs Used

| API | Purpose |
|-----|---------|
| `Form` | HTML form emulation with actions |
| `Link`, `NavLink` | Client-side navigation |
| `Outlet` | Nested route rendering |
| `clientLoader` / `loader` | Data loading (client/server) |
| `action` | Form submissions/mutations |
| `useNavigation` | Global navigation state |
| `useNavigate` | Programmatic navigation |
| `useSubmit` | Manual form submission |
| `useFetcher` | Non-navigating fetchers |

### Rendering Strategies

- **SPA (ssr: false)** - Client-side rendering only, easy to deploy statically
- **SSR (ssr: true)** - Server-side rendering with loader functions
- **Pre-rendering** - Static HTML generation at build time for specific URLs

All strategies are first-class citizens in React Router!

---

## Next Steps

Explore more APIs and advanced features on the [React Router documentation](https://reactrouter.com).
