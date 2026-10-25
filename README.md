# MACRO STUDIO

<p align="center">
  <strong>Visual Desktop Automation Builder</strong><br>
  A lightweight cross-platform desktop application to create, configure, and execute automation workflows without writing code.
</p>

---

## ⚡ Core Supported Actions

| Action | Type Identifier | Parameters | OS Execution Mechanism |
| :--- | :--- | :--- | :--- |
| **Open Application** | `openApp` | `appName` / path | macOS: `open -a`, Windows: `cmd.exe /c start`, Linux: process spawn |
| **Close Application** | `closeApp` | `appName` / process | macOS: `osascript` quit, Windows: `taskkill /IM`, Linux: `pkill -x` |
| **Open URL** | `openUrl` | `url` (http/https) | Electron `shell.openExternal(url)` in default browser |
| **Run Command** | `command` | `command`, `cwd` (opt) | Node `child_process.spawn` detached with dev-server grace period |
| **Pause Duration** | `wait` | `durationMs` (0 - 3600s) | Precision async timer with instant `AbortSignal` cancellation |
| **Wait for Port/URL** | `waitForUrl` | `url`, `timeout` (s) | Active polling loop checking HTTP response before proceeding |
| **Voice Announcement** | `speak` | `text` | Native OS text-to-speech engine (macOS `say` / Windows SAPI) |
| **Snap Window** | `snapWindow` | `appName`, `position` | Snaps target app window (Left Half, Right Half, Maximize) |
| **Show Notification**| `notification` | `message` | Electron native desktop `Notification` API |

---

## 🌟 Power Features

1. **Native Drag & Drop Reordering**: Grab the `⠿` handle on any action card to reorder your workflow sequence visually.
2. **Global Keyboard Hotkeys**: Bind any workflow to a system-wide hotkey (e.g. `CommandOrControl+Shift+C`) to trigger it instantly from anywhere.
3. **System Tray Integration**: Macro Studio minimizes to the macOS menu bar / Windows system tray with a quick-run popup menu for all macros.
4. **Daily Scheduled Triggers**: Configure a daily execution time (`HH:MM`, e.g. `09:00`) to automate morning work and focus routines.
5. **Dynamic Variables & Environment Interpolation**: Embed dynamic variables in commands, URLs, and speech text:
   - `{{DATE}}` — Current ISO date (`YYYY-MM-DD`)
   - `{{TIME}}` — Current local time (`HH:MM:SS`)
   - `{{USER}}` — Logged-in OS username
   - `{{HOME}}` — User home directory path
   - `{{env.VARIABLE}}` — Any operating system environment variable
6. **Workflow Import & Export**: Export single or all macros to `.json` files, or paste JSON snippets to share recipes with teammates.
7. **Starter Workflow Templates**: One-click setup for *Start Coding*, *Study & Research*, *Gaming Setup*, and *Daily Work Setup*.

---

## 🔒 Security Architecture

Macro Studio enforces enterprise-grade security boundaries adhering to Google & Microsoft desktop application guidelines:

1. **Context Isolation & Sandboxing**: `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` are strictly enforced across the window lifecycle.
2. **Strict ContextBridge**: Only explicit, sanitized asynchronous IPC endpoints are exposed to the DOM via `window.api`.
3. **Command Fingerprint Hashing**: Workflows containing terminal commands compute a SHA-256 fingerprint of all command strings and working directories. Any modification triggers a native confirmation dialog before execution.
4. **Heuristic Hazard Detection**: High-risk shell patterns (e.g., `rm -rf`, `sudo`, `format`, `del /s`, curl-pipe-to-shell) are flagged with prominent security warnings.
5. **Crash-Resilient Atomic Persistence**: All workflow writes use an atomic temporary swap (`fs.promises.rename`) with automated corrupted file isolation and recovery.
6. **Strict Content-Security-Policy**: Enforced on all window requests to block arbitrary remote code injection.

---

## 📂 Project Architecture

```text
macro-studio/
├── data/
│   └── templates.json          # Starter templates (Coding, Study, Gaming, Daily Work)
├── src/
│   ├── schema.js               # Validation rules, variable interpolation & injection defense
│   ├── storage.js              # Crash-resilient atomic JSON persistence & import/export
│   └── macroEngine.js          # Action execution orchestrator (process, TTS, window snapping, polling)
├── renderer/
│   ├── index.html              # Modern desktop UI shell & accessibility landmarks
│   ├── styles.css              # Obsidian glassmorphic design system (#07080b)
│   └── renderer.js             # Drag-and-drop action chain, settings strip & telemetry
├── test/
│   ├── schema.test.js          # Unit tests for parameter boundaries & sanitization
│   ├── storage.test.js         # Integration tests for atomic disk persistence & import/export
│   ├── macroEngine.test.js     # Tests for cancellation, heuristics & error recovery
│   └── run-tests.js            # Automated test suite aggregator
├── main.js                     # Electron main process, tray menu, global shortcuts & IPC
├── preload.js                  # Sandboxed ContextBridge API exposure
├── package.json                # Project dependencies, build scripts & packaging configuration
└── .editorconfig               # Workspace formatting standards
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** (v18.0.0 or higher)
- **npm** (v9.0.0 or higher)

### Installation
```bash
# Clone the repository
git clone git@github.com:Akshatshukla-25/Macro-Studio.git
cd Macro-Studio

# Install development dependencies
npm install
```

### Running the Application
```bash
# Launch Macro Studio in development mode
npm start

# Launch with verbose logging enabled
npm run dev
```

### Running Automated Test Suite
```bash
# Run schema, storage atomicity, import/export, and engine executor tests
npm test
```

### Keyboard Shortcuts
- <kbd>Cmd</kbd> / <kbd>Ctrl</kbd> + <kbd>S</kbd> — Save active workflow
- <kbd>Cmd</kbd> / <kbd>Ctrl</kbd> + <kbd>Enter</kbd> — Execute active workflow
- <kbd>Esc</kbd> — Abort running workflow / dismiss dialogs

---

## 📦 Desktop Packaging
Build platform-native executables and installers:
```bash
# Package for host platform
npm run dist
```
- **macOS**: DMG & ZIP archives (`dist/*.dmg`, `dist/*.zip`)
- **Windows**: NSIS executable installer (`dist/*.exe`)
- **Linux**: AppImage standalone bundle (`dist/*.AppImage`)

---

## 📜 License
Distributed under the **MIT License**.
