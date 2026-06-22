# Claude Code Default Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make official Anthropic Claude Code install by default and open as the primary right-side AI surface, while keeping native VS Code Chat reachable from a menu.

**Architecture:** Use VS Code's built-in extension product metadata so Claude Code follows normal extension install/update behavior. Use workbench defaults for right-side layout and a small startup contribution to open Claude's own sidebar command, falling back to its contributed secondary side-bar container.

**Tech Stack:** VS Code workbench TypeScript, `product.json` built-in extension metadata, existing configuration registry defaults.

---

### Task 1: Product Defaults

**Files:**
- Modify: `product.json`
- Modify: `src/vs/workbench/browser/workbench.contribution.ts`

- [ ] Add `Anthropic.claude-code` to `builtInExtensions`.
- [ ] Add `Anthropic.claude-code` to `builtInExtensionsEnabledWithAutoUpdates`.
- [ ] Add extension gallery service metadata if missing so built-in extension sync downloads from the extension gallery.
- [ ] Change the primary side bar default to `right`.
- [ ] Change the Claude Code preferred location default to `sidebar`.

### Task 2: Startup And Menu Bridge

**Files:**
- Modify: `src/vs/workbench/contrib/chat/electron-browser/chat.contribution.ts`

- [ ] Add a startup contribution that waits for extensions to register.
- [ ] Execute `claude-vscode.sidebar.open` without focus to let the official extension own its UI.
- [ ] Fall back to opening `claude-sidebar-secondary` in the secondary side bar if the command is unavailable.
- [ ] Add `Open VS Code Chat` to the contextual Chat config menu.

### Task 3: Verification

- [ ] Run a full compile.
- [ ] Launch a clean Code OSS profile.
- [ ] Confirm primary side bar defaults right.
- [ ] Confirm Claude Code opens in the right-side AI surface.
- [ ] Confirm native Chat remains reachable through the menu action.
