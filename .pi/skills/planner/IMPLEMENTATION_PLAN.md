# Chat UI Reimplementation Plan

## Overview

Reimplement `/home/david/projects/pi-hub/apps/chat-ui` according to the `WEB_UI_IMPLEMENTATION_GUIDE.md`, using `@mariozechner/pi-web-ui` package.

---

## Current State

- ✅ Directory exists at `/home/david/projects/pi-hub/apps/chat-ui/`
- ⚠️ Empty `src/` directory (no source files)
- ⚠️ No configuration files (`package.json`, `vite.config.ts`, `tsconfig.json`)
- ⚠️ Dependencies not installed

---

## Implementation Scope

### Phase 1: Project Setup ✅
- [x] Create `package.json` with required dependencies
- [x] Create `vite.config.ts` with Tailwind CSS v4 plugin
- [x] Create `tsconfig.json` with proper path mappings and compiler options
- [x] Create `index.html` entry point

### Phase 2: Core Implementation ✅
- [ ] Set up IndexedDB storage backend with all stores (Settings, ProviderKeys, Sessions)
- [ ] Initialize global AppStorage via `setAppStorage()`
- [ ] Configure Agent with model, system prompt, and tools
- [ ] Create ChatPanel component with event handlers
- [ ] Import and apply styling (`@mariozechner/pi-web-ui/app.css`)

### Phase 3: Features & Polish ✅
- [ ] Add API key prompt dialog integration
- [ ] Implement JavaScript REPL tool for code execution
- [ ] Add document extraction tool support
- [ ] Configure CORS proxy settings (if needed)
- [ ] Add theme toggle and settings dialog

---

## Dependencies Required

```json
{
  "dependencies": {
    "@lmstudio/sdk": "^1.5.0",
    "@mariozechner/pi-agent-core": "^0.67.3",
    "@mariozechner/pi-ai": "^0.67.3",
    "@mariozechner/pi-tui": "^0.67.3",
    "@mariozechner/pi-web-ui": "^0.67.3",
    "docx-preview": "^0.3.7",
    "jszip": "^3.10.1",
    "lucide": "^0.544.0",
    "ollama": "^0.6.0",
    "pdfjs-dist": "5.4.394",
    "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.17",
    "typescript": "^5.7.3",
    "vite": "^7.1.6"
  }
}
```

---

## File Structure

```
apps/chat-ui/
├── index.html                    # Entry HTML file
├── package.json                  # Dependencies and scripts
├── tsconfig.json                # TypeScript configuration
├── vite.config.ts               # Vite + Tailwind config
└── src/
    └── main.ts                  # Main application entry point
```

---

## Key Implementation Details

### Storage Setup Pattern

```typescript
import {
  AppStorage,
  IndexedDBStorageBackend,
  SettingsStore,
  ProviderKeysStore,
  SessionsStore,
  setAppStorage,
} from '@mariozechner/pi-web-ui';

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();

const backend = new IndexedDBStorageBackend({
  dbName: 'pi-hub-chat',
  version: 1,
  stores: [
    settings.getConfig(),
    providerKeys.getConfig(),
    sessions.getConfig(),
    SessionsStore.getMetadataConfig(),
  ],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, undefined, backend);
setAppStorage(storage);
```

### Agent Configuration

```typescript
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import { createJavaScriptReplTool, createExtractDocumentTool } from '@mariozechner/pi-web-ui';

const agent = new Agent({
  initialState: {
    systemPrompt: 'You are a helpful assistant.',
    model: getModel('anthropic', 'claude-sonnet-4-5-20250929'),
    thinkingLevel: 'off',
    messages: [],
    tools: [
      createJavaScriptReplTool(),
      createExtractDocumentTool(),
    ],
  },
  convertToLlm: defaultConvertToLlm,
});
```

### ChatPanel Initialization

```typescript
import { ChatPanel } from '@mariozechner/pi-web-ui';

const chatPanel = new ChatPanel();
await chatPanel.setAgent(agent, {
  onApiKeyRequired: (provider) => ApiKeyPromptDialog.prompt(provider),
});

document.body.appendChild(chatPanel);
```

---

## Acceptance Criteria

- [ ] Application builds successfully with `npm run build`
- [ ] Development server runs with `npm run dev`
- [ ] Chat interface renders correctly in browser
- [ ] Storage persists sessions to IndexedDB
- [ ] API key prompt dialog works for required providers
- [ ] Tools (REPL, document extraction) are functional
- [ ] Styling is applied correctly via CSS import

---

## Risks & Considerations

1. **Package Version Compatibility**: Ensure `@mariozechner/pi-web-ui` version matches guide (0.67.3)
2. **TypeScript Path Mapping**: May need to adjust paths if local packages exist
3. **CORS Proxy**: May require additional configuration for certain providers
4. **IndexedDB Support**: Verify browser compatibility (modern browsers only)

---

## Next Steps

1. Create project configuration files (`package.json`, `vite.config.ts`, `tsconfig.json`)
2. Install dependencies via `npm install`
3. Implement main application entry point (`src/main.ts`)
4. Test build and development server
5. Validate functionality in browser

---

## Definition of Done

- All configuration files created and validated
- Dependencies installed successfully
- Application builds without errors
- Chat UI renders and functions as expected
- Storage persistence verified
- Documentation updated if needed
