# Designer Branch Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Chat-side placeholder with a working designer branch switcher that shows a unified branch tree, lets designers create `design/<name>` branches from the default branch, and switches branches through a Git-extension command boundary.

**Architecture:** The workbench toolbar owns presentation only. Git branch discovery, branch normalization, checkout, and branch creation live in the built-in Git extension and are exposed through internal commands. Autosync is introduced as a status model and command boundary in this slice, with full periodic sync and conflict recovery implemented after the branch switcher is stable.

**Tech Stack:** VS Code workbench TypeScript, built-in Git extension TypeScript, command service, context-view dropdown UI, existing Git repository APIs, Mocha unit tests.

---

## File Structure

- Create `extensions/git/src/designerBranchTypes.ts`: shared DTO types for the workbench/extension command boundary.
- Create `extensions/git/src/designerBranchModel.ts`: pure helpers that merge local/remote refs into branch status records and build a slash-path tree.
- Create `extensions/git/src/designerBranchModel.test.ts`: unit tests for branch merge, status assignment, tree building, and default `design/` branch naming.
- Modify `extensions/git/src/commands.ts`: register internal designer branch commands backed by the active repository.
- Create `src/vs/workbench/browser/parts/designerBranchSwitcher/designerBranchSwitcher.ts`: workbench UI component for the toolbar button, dropdown tree, and new-branch form.
- Create `src/vs/workbench/browser/parts/designerBranchSwitcher/designerBranchSwitcher.css`: scoped switcher styles.
- Modify `src/vs/workbench/browser/parts/paneCompositePart.ts`: replace placeholder creation with the switcher component and refresh it on Chat activation.
- Modify `src/vs/workbench/browser/parts/media/paneCompositePart.css`: remove placeholder-only styles after the switcher owns its CSS.

## Task 1: Pure Branch Model

**Files:**
- Create: `extensions/git/src/designerBranchTypes.ts`
- Create: `extensions/git/src/designerBranchModel.ts`
- Create: `extensions/git/src/designerBranchModel.test.ts`

- [ ] **Step 1: Add DTO types**

Create `extensions/git/src/designerBranchTypes.ts`:

```ts
export type DesignerBranchStatus = 'synced' | 'remoteOnly' | 'localOnly' | 'problem';

export interface DesignerBranchRef {
	readonly name: string;
	readonly remote?: string;
	readonly commit?: string;
	readonly type: 'local' | 'remote';
	readonly upstream?: {
		readonly remote: string;
		readonly name: string;
	};
}

export interface DesignerBranchItem {
	readonly name: string;
	readonly path: readonly string[];
	readonly status: DesignerBranchStatus;
	readonly localName?: string;
	readonly remoteName?: string;
	readonly remote?: string;
	readonly isCurrent: boolean;
	readonly isDefault: boolean;
}

export interface DesignerBranchTreeNode {
	readonly name: string;
	readonly path: readonly string[];
	readonly branch?: DesignerBranchItem;
	readonly children: readonly DesignerBranchTreeNode[];
}
```

- [ ] **Step 2: Write failing model tests**

Create `extensions/git/src/designerBranchModel.test.ts`:

```ts
import * as assert from 'assert';
import { buildDesignerBranchTree, getDesignerBranchName, mergeDesignerBranchRefs } from './designerBranchModel.js';
import { DesignerBranchRef } from './designerBranchTypes.js';

suite('Designer Branch Model', () => {
	test('merges matching local and remote branches as synced', () => {
		const refs: DesignerBranchRef[] = [
			{ type: 'local', name: 'design/card', commit: 'abc', upstream: { remote: 'origin', name: 'design/card' } },
			{ type: 'remote', remote: 'origin', name: 'design/card', commit: 'abc' },
		];

		const branches = mergeDesignerBranchRefs(refs, 'origin', 'main', 'design/card');

		assert.strictEqual(branches.length, 1);
		assert.strictEqual(branches[0].name, 'design/card');
		assert.strictEqual(branches[0].status, 'synced');
		assert.strictEqual(branches[0].isCurrent, true);
	});

	test('marks remote-only branches as remoteOnly', () => {
		const refs: DesignerBranchRef[] = [
			{ type: 'remote', remote: 'origin', name: 'design/remote-card', commit: 'def' },
		];

		const branches = mergeDesignerBranchRefs(refs, 'origin', 'main', 'main');

		assert.strictEqual(branches[0].status, 'remoteOnly');
	});

	test('marks local-only branches as localOnly', () => {
		const refs: DesignerBranchRef[] = [
			{ type: 'local', name: 'design/local-card', commit: 'abc' },
		];

		const branches = mergeDesignerBranchRefs(refs, 'origin', 'main', 'main');

		assert.strictEqual(branches[0].status, 'localOnly');
	});

	test('pins the default branch before slash-path branches', () => {
		const refs: DesignerBranchRef[] = [
			{ type: 'remote', remote: 'origin', name: 'design/card', commit: 'def' },
			{ type: 'local', name: 'main', commit: 'abc' },
		];

		const branches = mergeDesignerBranchRefs(refs, 'origin', 'main', 'main');

		assert.strictEqual(branches[0].name, 'main');
		assert.strictEqual(branches[0].isDefault, true);
	});

	test('builds slash-separated branches as a tree', () => {
		const branches = mergeDesignerBranchRefs([
			{ type: 'local', name: 'main', commit: 'aaa' },
			{ type: 'remote', remote: 'origin', name: 'design/card', commit: 'bbb' },
			{ type: 'remote', remote: 'origin', name: 'design/modal', commit: 'ccc' },
		], 'origin', 'main', 'main');

		const tree = buildDesignerBranchTree(branches);

		assert.strictEqual(tree[0].name, 'main');
		assert.strictEqual(tree[1].name, 'design');
		assert.deepStrictEqual(tree[1].children.map(child => child.name), ['card', 'modal']);
	});

	test('creates design-prefixed names by default', () => {
		assert.strictEqual(getDesignerBranchName('landing page', true), 'design/landing-page');
		assert.strictEqual(getDesignerBranchName('landing page', false), 'landing-page');
	});
});
```

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
npm run test-node -- --grep "Designer Branch Model"
```

Expected: FAIL because `designerBranchModel.ts` does not exist.

- [ ] **Step 4: Implement the pure model**

Create `extensions/git/src/designerBranchModel.ts`:

```ts
import { DesignerBranchItem, DesignerBranchRef, DesignerBranchTreeNode } from './designerBranchTypes.js';

export function mergeDesignerBranchRefs(refs: readonly DesignerBranchRef[], defaultRemote: string, defaultBranch: string, currentBranch: string | undefined): DesignerBranchItem[] {
	const byName = new Map<string, { local?: DesignerBranchRef; remote?: DesignerBranchRef }>();

	for (const ref of refs) {
		const key = ref.name;
		const entry = byName.get(key) ?? {};
		if (ref.type === 'local') {
			entry.local = ref;
		} else if (ref.remote === defaultRemote) {
			entry.remote = ref;
		}
		byName.set(key, entry);
	}

	const branches = Array.from(byName.entries()).map(([name, entry]): DesignerBranchItem => {
		const isSynced = !!entry.local && !!entry.remote && entry.local.commit === entry.remote.commit;
		const status = isSynced ? 'synced' : entry.local && entry.remote ? 'problem' : entry.local ? 'localOnly' : 'remoteOnly';

		return {
			name,
			path: name.split('/').filter(Boolean),
			status,
			localName: entry.local?.name,
			remoteName: entry.remote?.name,
			remote: entry.remote?.remote ?? entry.local?.upstream?.remote,
			isCurrent: currentBranch === name,
			isDefault: name === defaultBranch
		};
	});

	return branches.sort((a, b) => {
		if (a.isDefault !== b.isDefault) {
			return a.isDefault ? -1 : 1;
		}

		return a.name.localeCompare(b.name);
	});
}

export function buildDesignerBranchTree(branches: readonly DesignerBranchItem[]): DesignerBranchTreeNode[] {
	const roots: DesignerBranchTreeNode[] = [];

	for (const branch of branches) {
		let children = roots;
		let path: string[] = [];

		for (const segment of branch.path) {
			path = [...path, segment];
			let node = children.find(child => child.name === segment);
			if (!node) {
				node = { name: segment, path, children: [] };
				children.push(node);
			}

			if (path.length === branch.path.length) {
				node = { ...node, branch };
				const index = children.findIndex(child => child.name === segment);
				children[index] = node;
			}

			children = node.children as DesignerBranchTreeNode[];
		}
	}

	sortTree(roots);
	return roots;
}

export function getDesignerBranchName(input: string, useDesignPrefix: boolean): string {
	const sanitized = input.trim().toLowerCase().replace(/[^a-z0-9/_-]+/g, '-').replace(/^-+|-+$/g, '').replace(/\/+/g, '/');
	return useDesignPrefix ? `design/${sanitized.replace(/^design\//, '')}` : sanitized;
}

function sortTree(nodes: DesignerBranchTreeNode[]): void {
	nodes.sort((a, b) => {
		if (a.branch?.isDefault !== b.branch?.isDefault) {
			return a.branch?.isDefault ? -1 : 1;
		}

		return a.name.localeCompare(b.name);
	});

	for (const node of nodes) {
		sortTree(node.children as DesignerBranchTreeNode[]);
	}
}
```

- [ ] **Step 5: Run model tests**

Run:

```bash
npm run test-node -- --grep "Designer Branch Model"
```

Expected: PASS for all Designer Branch Model tests.

## Task 2: Git Extension Command Boundary

**Files:**
- Modify: `extensions/git/src/commands.ts`
- Use: `extensions/git/src/designerBranchModel.ts`
- Use: `extensions/git/src/designerBranchTypes.ts`

- [ ] **Step 1: Add internal command constants near existing command definitions**

In `extensions/git/src/commands.ts`, add:

```ts
const DESIGNER_BRANCHES_GET_STATE = '_designerBranches.getState';
const DESIGNER_BRANCHES_CHECKOUT = '_designerBranches.checkout';
const DESIGNER_BRANCHES_CREATE = '_designerBranches.create';
```

- [ ] **Step 2: Register get-state command**

Add a command handler that returns:

```ts
{
	projectName: repository.root.basename,
	defaultBranch,
	currentBranch: repository.HEAD?.name,
	syncState: 'synced',
	branches: mergeDesignerBranchRefs(refs, defaultRemote, defaultBranch, repository.HEAD?.name),
	tree: buildDesignerBranchTree(branches)
}
```

Implementation should use repository refs already exposed in the Git extension. If default branch detection fails, fall back to `repository.HEAD?.upstream?.name`, then `main`, then `master` if present in refs.

- [ ] **Step 3: Register checkout command**

Add `_designerBranches.checkout` with payload:

```ts
interface CheckoutDesignerBranchPayload {
	readonly branchName: string;
}
```

Behavior:

1. Find the selected branch.
2. If local exists, call `repository.checkout(branchName, { pullBeforeCheckout: true })`.
3. If only remote exists, call `repository.checkoutTracking(remoteName)`.
4. Return the fresh get-state payload.

- [ ] **Step 4: Register create command**

Add `_designerBranches.create` with payload:

```ts
interface CreateDesignerBranchPayload {
	readonly branchName: string;
}
```

Behavior:

1. Checkout the detected default branch.
2. Pull the default branch.
3. Create and checkout the requested branch from the default branch with `repository.branch(branchName, true, defaultBranch)`.
4. Return the fresh get-state payload.

- [ ] **Step 5: Compile extension**

Run:

```bash
TMPDIR=/tmp npm_config_registry=https://registry.npmmirror.com npm run compile
```

Expected: compile completes with 0 errors.

## Task 3: Workbench Switcher Component

**Files:**
- Create: `src/vs/workbench/browser/parts/designerBranchSwitcher/designerBranchSwitcher.ts`
- Create: `src/vs/workbench/browser/parts/designerBranchSwitcher/designerBranchSwitcher.css`
- Modify: `src/vs/workbench/browser/parts/paneCompositePart.ts`
- Modify: `src/vs/workbench/browser/parts/media/paneCompositePart.css`

- [ ] **Step 1: Create the component skeleton**

Create `src/vs/workbench/browser/parts/designerBranchSwitcher/designerBranchSwitcher.ts` with:

```ts
import './designerBranchSwitcher.css';
import { $, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

const DESIGNER_BRANCHES_GET_STATE = '_designerBranches.getState';
const DESIGNER_BRANCHES_CHECKOUT = '_designerBranches.checkout';
const DESIGNER_BRANCHES_CREATE = '_designerBranches.create';

export class DesignerBranchSwitcher extends Disposable {
	private readonly element: HTMLElement;
	private readonly label: HTMLElement;
	private readonly cloudState: HTMLElement;
	private readonly dropdown: HTMLElement;

	constructor(
		parent: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = $('.designer-branch-switcher');
		this.label = $('.designer-branch-switcher-label');
		this.cloudState = $('.designer-branch-switcher-cloud.codicon.codicon-cloud');
		this.dropdown = $('.designer-branch-switcher-dropdown');
		this.dropdown.hidden = true;

		this.element.append(this.label, this.cloudState, this.dropdown);
		parent.appendChild(this.element);

		this._register(addDisposableListener(this.element, EventType.CLICK, () => this.toggleDropdown()));
		this.refresh();
	}

	async refresh(): Promise<void> {
		try {
			const state = await this.commandService.executeCommand<any>(DESIGNER_BRANCHES_GET_STATE);
			this.label.textContent = `${state.projectName}: ${state.currentBranch ?? state.defaultBranch ?? 'No branch'}`;
			this.renderDropdown(state);
		} catch {
			this.label.textContent = 'No project branch';
			this.cloudState.className = 'designer-branch-switcher-cloud codicon codicon-warning';
		}
	}

	private toggleDropdown(): void {
		this.dropdown.hidden = !this.dropdown.hidden;
	}

	private renderDropdown(state: any): void {
		this.dropdown.replaceChildren();

		const list = $('.designer-branch-switcher-tree');
		for (const branch of state.branches ?? []) {
			const item = $('button.designer-branch-switcher-branch');
			item.classList.add(`status-${branch.status}`);
			item.textContent = branch.name;
			item.disabled = branch.isCurrent;
			this._register(addDisposableListener(item, EventType.CLICK, async event => {
				event.stopPropagation();
				await this.commandService.executeCommand(DESIGNER_BRANCHES_CHECKOUT, { branchName: branch.name });
				this.dropdown.hidden = true;
				await this.refresh();
			}));
			list.appendChild(item);
		}

		const newBranch = $('button.designer-branch-switcher-new');
		newBranch.textContent = '+ New design branch';
		this._register(addDisposableListener(newBranch, EventType.CLICK, event => {
			event.stopPropagation();
			this.renderNewBranchForm();
		}));

		this.dropdown.append(list, newBranch);
	}

	private renderNewBranchForm(): void {
		this.dropdown.replaceChildren();
		const form = $('.designer-branch-switcher-new-form');
		const prefix = $('span.designer-branch-switcher-prefix');
		prefix.textContent = 'design/';
		const input = $('input.designer-branch-switcher-input') as HTMLInputElement;
		input.placeholder = 'landing-page';
		const create = $('button.designer-branch-switcher-create');
		create.textContent = 'Create';

		this._register(addDisposableListener(create, EventType.CLICK, async event => {
			event.stopPropagation();
			const name = input.value.trim().replace(/\\s+/g, '-');
			if (!name) {
				return;
			}
			await this.commandService.executeCommand(DESIGNER_BRANCHES_CREATE, { branchName: `design/${name}` });
			this.dropdown.hidden = true;
			await this.refresh();
		}));

		form.append(prefix, input, create);
		this.dropdown.appendChild(form);
		input.focus();
	}
}
```

- [ ] **Step 2: Style the switcher**

Create `src/vs/workbench/browser/parts/designerBranchSwitcher/designerBranchSwitcher.css`:

```css
.designer-branch-switcher {
	position: relative;
	display: flex;
	align-items: center;
	box-sizing: border-box;
	height: 35px;
	padding: 0 10px;
	gap: 8px;
	background-color: var(--vscode-sideBar-background);
	color: var(--vscode-sideBarTitle-foreground);
	border-bottom: 1px solid var(--vscode-sideBarActivityBarTop-border);
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	cursor: pointer;
}

.designer-branch-switcher-label {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.designer-branch-switcher-cloud {
	flex: 0 0 auto;
}

.designer-branch-switcher-dropdown {
	position: absolute;
	top: 34px;
	left: 8px;
	right: 8px;
	z-index: 50;
	display: flex;
	flex-direction: column;
	padding: 6px;
	border: 1px solid var(--vscode-dropdown-border);
	background-color: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	box-shadow: 0 4px 12px var(--vscode-widget-shadow);
	text-transform: none;
	font-weight: normal;
}

.designer-branch-switcher-dropdown[hidden] {
	display: none;
}

.designer-branch-switcher-tree {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.designer-branch-switcher-branch,
.designer-branch-switcher-new,
.designer-branch-switcher-create {
	text-align: left;
	border: 0;
	color: inherit;
	background: transparent;
	height: 26px;
	padding: 0 8px;
	border-radius: 4px;
}

.designer-branch-switcher-branch:hover,
.designer-branch-switcher-new:hover,
.designer-branch-switcher-create:hover {
	background-color: var(--vscode-list-hoverBackground);
}

.designer-branch-switcher-branch.status-remoteOnly {
	opacity: 0.6;
}

.designer-branch-switcher-branch.status-localOnly {
	color: var(--vscode-inputValidation-warningForeground);
	background-color: var(--vscode-inputValidation-warningBackground);
}

.designer-branch-switcher-new-form {
	display: flex;
	align-items: center;
	gap: 6px;
}

.designer-branch-switcher-prefix {
	opacity: 0.65;
}

.designer-branch-switcher-input {
	min-width: 0;
	flex: 1;
	height: 26px;
	box-sizing: border-box;
}
```

- [ ] **Step 3: Replace placeholder in `paneCompositePart.ts`**

Import the component:

```ts
import { DesignerBranchSwitcher } from './designerBranchSwitcher/designerBranchSwitcher.js';
```

Replace `projectToolbarPlaceholder: HTMLElement | undefined;` with:

```ts
private projectToolbarElement: HTMLElement | undefined;
private projectToolbarSwitcher: DesignerBranchSwitcher | undefined;
```

In `updateProjectToolbarPlaceholder`, replace placeholder creation with:

```ts
this.projectToolbarElement = $('.project-toolbar-placeholder');
this.projectToolbarSwitcher = this._register(this.instantiationService.createInstance(DesignerBranchSwitcher, this.projectToolbarElement));
this.setHeaderArea(this.projectToolbarElement);
```

When removing the toolbar, set both fields to `undefined`.

- [ ] **Step 4: Remove placeholder text styling**

In `src/vs/workbench/browser/parts/media/paneCompositePart.css`, reduce `.project-toolbar-placeholder` to layout-only:

```css
.monaco-workbench .pane-composite-part > .project-toolbar-placeholder {
	height: 35px;
}
```

- [ ] **Step 5: Compile**

Run:

```bash
TMPDIR=/tmp npm_config_registry=https://registry.npmmirror.com npm run compile
```

Expected: compile completes with 0 errors.

## Task 4: Manual Verification

**Files:**
- No code files.
- Uses current source build.

- [ ] **Step 1: Launch Code OSS directly**

Run:

```bash
zsh -lc 'source "$HOME/.nvm/nvm.sh" && nvm use 24.15.0 && VSCODE_SKIP_PRELAUNCH=1 TMPDIR=/tmp /Users/tombar-gal/Documents/VSCode-Fork/scripts/code.sh --user-data-dir=/tmp/vscode-fork-designer-user --extensions-dir=/tmp/vscode-fork-designer-ext --shared-data-dir=/tmp/vscode-fork-designer-shared --remote-debugging-port=62680 --inspect-extensions=62681 --inspect=62682 --inspect-agenthost=62683 /Users/tombar-gal/Documents/VSCode-Fork'
```

Expected: Code OSS opens and DevTools listens on port `62680`.

- [ ] **Step 2: Attach Playwright**

Run:

```bash
TMPDIR=/tmp npx @playwright/cli -s=vscode-designer-switcher attach --cdp=http://127.0.0.1:62680
```

Expected: Playwright attaches to `Welcome — VSCode-Fork`.

- [ ] **Step 3: Open Chat**

Run:

```bash
TMPDIR=/tmp npx @playwright/cli -s=vscode-designer-switcher press Shift+Meta+i
```

Expected: Chat opens in the auxiliary bar.

- [ ] **Step 4: Verify switcher is above Chat title**

Run:

```bash
TMPDIR=/tmp npx @playwright/cli -s=vscode-designer-switcher eval '(() => { const toolbar = document.querySelector(".designer-branch-switcher"); const title = document.querySelector(".pane-composite-part.auxiliarybar > .title"); return { text: toolbar?.textContent?.trim(), above: !!toolbar && !!title && toolbar.getBoundingClientRect().bottom <= title.getBoundingClientRect().top }; })()'
```

Expected: `above` is `true` and `text` contains the project and current branch.

- [ ] **Step 5: Verify dropdown opens**

Run:

```bash
TMPDIR=/tmp npx @playwright/cli -s=vscode-designer-switcher click .designer-branch-switcher
```

Expected: dropdown opens with branch rows and `+ New design branch`.

## Task 5: Commit

**Files:**
- All files changed by Tasks 1-4.

- [ ] **Step 1: Review diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended files are modified or added.

- [ ] **Step 2: Commit**

Run:

```bash
git add extensions/git/src/designerBranchTypes.ts extensions/git/src/designerBranchModel.ts extensions/git/src/designerBranchModel.test.ts extensions/git/src/commands.ts src/vs/workbench/browser/parts/designerBranchSwitcher/designerBranchSwitcher.ts src/vs/workbench/browser/parts/designerBranchSwitcher/designerBranchSwitcher.css src/vs/workbench/browser/parts/paneCompositePart.ts src/vs/workbench/browser/parts/media/paneCompositePart.css docs/superpowers/specs/2026-06-21-designer-branch-switcher-design.md docs/superpowers/plans/2026-06-21-designer-branch-switcher.md
git commit -m "feat: add designer branch switcher"
```

Expected: commit succeeds.

## Follow-Up Plan

After this vertical slice works, create a second plan for automatic cloud save:

- periodic dirty-state detection
- checkpoint commit creation
- push and retry policy
- recovery surface
- copy prompt to coding agent
- Advanced override flow

Keeping that separate reduces risk because branch UI and Git autosync failure handling are two large behaviors.
