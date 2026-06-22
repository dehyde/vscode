/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './designerBranchSwitcher.css';
import { $, addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { localize } from '../../../../nls.js';

type DesignerBranchStatus = 'synced' | 'remoteOnly' | 'localOnly' | 'problem';

interface DesignerBranchItem {
	readonly name: string;
	readonly path: readonly string[];
	readonly status: DesignerBranchStatus;
	readonly isCurrent: boolean;
	readonly isDefault: boolean;
}

interface DesignerBranchTreeNode {
	readonly name: string;
	readonly path: readonly string[];
	readonly branch?: DesignerBranchItem;
	readonly children: readonly DesignerBranchTreeNode[];
}

interface DesignerBranchState {
	readonly projectName: string;
	readonly defaultBranch: string | undefined;
	readonly currentBranch: string | undefined;
	readonly syncState: 'synced' | 'syncing' | 'problem';
	readonly branches: readonly DesignerBranchItem[];
	readonly tree: readonly DesignerBranchTreeNode[];
}

interface DesignerBranchCheckoutResult {
	readonly state: DesignerBranchState;
	readonly blocked?: {
		readonly reason: 'dirtyWorkTree' | 'worktreeBranchAlreadyUsed' | 'branchNameRequired' | 'saveFailed';
		readonly message: string;
	};
}

type DesignerRepoStatus = 'ready' | 'cloning' | 'problem';

interface DesignerRepoItem {
	readonly name: string;
	readonly path: string;
	readonly status: DesignerRepoStatus;
	readonly isCurrent: boolean;
	readonly url?: string;
	readonly message?: string;
}

interface DesignerRepoState {
	readonly currentRepoPath: string | undefined;
	readonly repos: readonly DesignerRepoItem[];
}

interface DesignerRepoSwitchResult {
	readonly state: DesignerRepoState;
	readonly blocked?: {
		readonly reason: 'branchNameRequired' | 'saveFailed';
		readonly message: string;
	};
}

export class DesignerBranchSwitcher extends Disposable {

	private static readonly startupRefreshRetryDelayMs = 250;
	private static readonly maxStartupRefreshAttempts = 40;

	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly windowDisposables = this._register(new DisposableStore());
	private readonly container: HTMLElement;
	private readonly repoButton: HTMLButtonElement;
	private readonly branchButton: HTMLButtonElement;
	private readonly dropdown: HTMLElement;

	private state: DesignerBranchState | undefined;
	private repoState: DesignerRepoState | undefined;
	private filterInput: HTMLInputElement | undefined;
	private repoUrlInput: HTMLInputElement | undefined;
	private currentBranchRow: HTMLElement | undefined;
	private problemMessage: string | undefined;
	private repoProblemMessage: string | undefined;
	private blockedCheckoutBranchName: string | undefined;
	private dropdownMode: 'branch' | 'repo' | undefined;
	private refreshingBranches = false;
	private refreshingRepos = false;
	private switchingBranchName: string | undefined;
	private switchingRepoPath: string | undefined;
	private cloningRepoUrl: string | undefined;
	private treeRenderDeferred = false;
	private refreshPromise: Promise<void> | undefined;
	private repoRefreshPromise: Promise<void> | undefined;
	private startupRefreshAttempts = 0;
	private startupRefreshRetryHandle: number | undefined;
	private useDesignPrefix = true;
	private branchFilter = '';
	private disposed = false;

	constructor(
		parent: HTMLElement,
		@ICommandService private readonly commandService: ICommandService
	) {
		super();

		this.container = $('.designer-branch-switcher');
		this.repoButton = document.createElement('button');
		this.repoButton.className = 'designer-branch-switcher__button designer-branch-switcher__repo-button';
		this.repoButton.type = 'button';
		this.repoButton.setAttribute('aria-haspopup', 'menu');

		this.branchButton = document.createElement('button');
		this.branchButton.className = 'designer-branch-switcher__button designer-branch-switcher__branch-button';
		this.branchButton.type = 'button';
		this.branchButton.setAttribute('aria-haspopup', 'menu');

		this.dropdown = $('.designer-branch-switcher__dropdown');
		this.dropdown.hidden = true;

		this.container.append(this.repoButton, $('span.designer-branch-switcher__separator', undefined, ':'), this.branchButton, this.dropdown);
		parent.appendChild(this.container);

		this._register(addDisposableListener(this.repoButton, EventType.CLICK, () => this.toggleRepoDropdown()));
		this._register(addDisposableListener(this.branchButton, EventType.CLICK, () => this.toggleBranchDropdown()));
		this._register(toDisposable(() => this.clearStartupRefreshRetry()));

		this.render();
		this.refresh({ retryDuringStartup: true });
		this.refreshRepos();
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	private async toggleBranchDropdown(): Promise<void> {
		this.dropdownMode = this.dropdownMode === 'branch' ? undefined : 'branch';

		if (this.dropdownMode === 'branch') {
			this.branchFilter = '';
			this.deferTreeRender();
			this.installWindowListeners();
			this.refresh({ updateRemotes: true });
		} else {
			this.windowDisposables.clear();
		}

		this.render();
		this.focusFilterInput();
		this.scrollCurrentBranchIntoView();
	}

	private async toggleRepoDropdown(): Promise<void> {
		this.dropdownMode = this.dropdownMode === 'repo' ? undefined : 'repo';

		if (this.dropdownMode === 'repo') {
			this.installWindowListeners();
			this.refreshRepos();
		} else {
			this.windowDisposables.clear();
		}

		this.render();
		this.focusRepoUrlInput();
	}

	private deferTreeRender(): void {
		this.treeRenderDeferred = true;

		const targetWindow = getWindow(this.container);
		targetWindow.requestAnimationFrame(() => {
			if (this.dropdownMode !== 'branch') {
				this.treeRenderDeferred = false;
				return;
			}

			this.treeRenderDeferred = false;
			this.render();
			this.focusFilterInput();
			this.scrollCurrentBranchIntoView();
		});
	}

	private focusFilterInput(): void {
		if (this.dropdownMode !== 'branch') {
			return;
		}

		getWindow(this.container).requestAnimationFrame(() => {
			this.filterInput?.focus({ preventScroll: true });
			this.filterInput?.setSelectionRange(this.filterInput.value.length, this.filterInput.value.length);
		});
	}

	private focusRepoUrlInput(): void {
		if (this.dropdownMode !== 'repo') {
			return;
		}

		getWindow(this.container).requestAnimationFrame(() => {
			this.repoUrlInput?.focus({ preventScroll: true });
			this.repoUrlInput?.setSelectionRange(this.repoUrlInput.value.length, this.repoUrlInput.value.length);
		});
	}

	private scrollCurrentBranchIntoView(): void {
		if (this.dropdownMode !== 'branch') {
			return;
		}

		const targetWindow = getWindow(this.container);
		targetWindow.requestAnimationFrame(() => {
			targetWindow.requestAnimationFrame(() => {
				this.currentBranchRow?.scrollIntoView({ block: 'center' });
			});
		});
	}

	private installWindowListeners(): void {
		this.windowDisposables.clear();

		const targetWindow = getWindow(this.container);
		this.windowDisposables.add(addDisposableListener(targetWindow.document, EventType.MOUSE_DOWN, event => {
			if (!this.container.contains(event.target as Node)) {
				this.dropdownMode = undefined;
				this.windowDisposables.clear();
				this.render();
			}
		}));

		this.windowDisposables.add(addDisposableListener(targetWindow.document, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				this.closeDropdown();
			}
		}));
	}

	private closeDropdown(): void {
		this.dropdownMode = undefined;
		this.windowDisposables.clear();
		this.render();
	}

	private refresh(options: { updateRemotes?: boolean; retryDuringStartup?: boolean } = {}): void {
		if (this.refreshPromise) {
			return;
		}

		this.clearStartupRefreshRetry();
		this.refreshingBranches = true;
		this.problemMessage = undefined;
		this.blockedCheckoutBranchName = undefined;
		this.render();

		this.refreshPromise = this.doRefresh(options)
			.catch(error => {
				this.problemMessage = getErrorMessage(error);
				this.scheduleStartupRefreshRetry(options);
			})
			.finally(() => {
				this.refreshPromise = undefined;
				this.refreshingBranches = false;
				this.render();
				this.focusFilterInput();
				this.scrollCurrentBranchIntoView();
			});
	}

	private refreshRepos(): void {
		if (this.repoRefreshPromise) {
			return;
		}

		this.refreshingRepos = true;
		this.repoProblemMessage = undefined;
		this.render();

		this.repoRefreshPromise = this.doRefreshRepos()
			.catch(error => {
				this.repoProblemMessage = getErrorMessage(error);
			})
			.finally(() => {
				this.repoRefreshPromise = undefined;
				this.refreshingRepos = false;
				this.render();
				this.focusRepoUrlInput();
			});
	}

	private async doRefreshRepos(): Promise<void> {
		this.repoState = await this.commandService.executeCommand<DesignerRepoState>('_designerRepos.getState');
	}

	private async doRefresh(options: { updateRemotes?: boolean }): Promise<void> {
		this.state = await this.commandService.executeCommand<DesignerBranchState>('_designerBranches.getState', { updateRemotes: options.updateRemotes === true });
		this.startupRefreshAttempts = 0;
	}

	private scheduleStartupRefreshRetry(options: { updateRemotes?: boolean; retryDuringStartup?: boolean }): void {
		if (!options.retryDuringStartup || this.dropdownMode) {
			return;
		}

		if (this.startupRefreshAttempts >= DesignerBranchSwitcher.maxStartupRefreshAttempts) {
			return;
		}

		this.startupRefreshAttempts++;
		this.startupRefreshRetryHandle = getWindow(this.container).setTimeout(() => {
			this.startupRefreshRetryHandle = undefined;
			this.refresh(options);
		}, DesignerBranchSwitcher.startupRefreshRetryDelayMs);
	}

	private clearStartupRefreshRetry(): void {
		if (this.startupRefreshRetryHandle === undefined) {
			return;
		}

		getWindow(this.container).clearTimeout(this.startupRefreshRetryHandle);
		this.startupRefreshRetryHandle = undefined;
	}

	private render(): void {
		if (this.disposed) {
			return;
		}

		this.renderDisposables.clear();
		this.filterInput = undefined;
		this.repoUrlInput = undefined;
		this.currentBranchRow = undefined;
		this.repoButton.replaceChildren();
		this.branchButton.replaceChildren();
		this.dropdown.replaceChildren();
		this.dropdown.hidden = !this.dropdownMode;
		this.repoButton.setAttribute('aria-expanded', String(this.dropdownMode === 'repo'));
		this.branchButton.setAttribute('aria-expanded', String(this.dropdownMode === 'branch'));

		const projectName = this.repoState?.repos.find(repo => repo.isCurrent)?.name ?? this.state?.projectName ?? localize('designerBranchSwitcherProjectFallback', "Project");
		const branchName = this.switchingBranchName ?? this.state?.currentBranch ?? this.state?.defaultBranch ?? localize('designerBranchSwitcherNoBranch', "No branch");

		this.repoButton.append($('span.designer-branch-switcher__project', undefined, projectName));
		this.branchButton.append(
			this.renderBranchIndicatorIcon(),
			$('span.designer-branch-switcher__branch', undefined, branchName)
		);

		if (!this.dropdownMode) {
			return;
		}

		if (this.dropdownMode === 'repo') {
			this.renderRepoDropdown();
			return;
		}

		if (this.problemMessage) {
			this.dropdown.append(this.renderProblem(this.problemMessage));
		}

		if (this.refreshingBranches && !this.state) {
			this.dropdown.append(
				this.renderFilter(),
				$('.designer-branch-switcher__empty', undefined, localize('designerBranchSwitcherLoading', "Loading branches...")),
				this.renderNewBranch()
			);
			return;
		}

		this.dropdown.append(this.renderFilter(), this.renderTree(), this.renderNewBranch());
	}

	private renderRepoDropdown(): void {
		if (this.repoProblemMessage) {
			this.dropdown.append(this.renderProblem(this.repoProblemMessage));
		}

		this.dropdown.append(this.renderRepoList(), this.renderAddRepo());
	}

	private renderBranchIndicatorIcon(): HTMLElement {
		const syncState = this.problemMessage ? 'problem' : this.isBusy() ? 'syncing' : this.state?.syncState ?? 'syncing';
		const icon = document.createElement('span');
		icon.classList.add('codicon', 'designer-branch-switcher__sync', `designer-branch-switcher__sync--${syncState}`);

		if (syncState === 'syncing') {
			icon.classList.add('codicon-sync', 'codicon-modifier-spin');
		} else if (syncState === 'problem') {
			icon.classList.add('codicon-error');
		} else {
			icon.classList.add('codicon-cloud');
		}

		const title = syncState === 'syncing'
			? this.switchingBranchName
				? localize('designerBranchSwitcherSwitching', "Switching branches")
				: localize('designerBranchSwitcherSyncing', "Syncing")
			: syncState === 'problem'
				? localize('designerBranchSwitcherProblem', "Sync problem")
				: localize('designerBranchSwitcherSynced', "Synced");

		icon.title = title;
		return icon;
	}

	private renderProblem(message: string): HTMLElement {
		const problem = $('.designer-branch-switcher__problem');
		problem.append(
			$('span.codicon.codicon-warning.designer-branch-switcher__problem-icon'),
			$('span.designer-branch-switcher__problem-message', undefined, message)
		);

		if (this.blockedCheckoutBranchName) {
			const actions = $('.designer-branch-switcher__problem-actions');
			const save = document.createElement('button');
			save.className = 'designer-branch-switcher__problem-action';
			save.type = 'button';
			save.textContent = localize('designerBranchSwitcherSaveAndSwitch', "Save and switch");

			const dismiss = document.createElement('button');
			dismiss.className = 'designer-branch-switcher__problem-dismiss';
			dismiss.type = 'button';
			dismiss.title = localize('designerBranchSwitcherDismissProblem', "Dismiss");
			dismiss.append($('span.codicon.codicon-close'));

			this.renderDisposables.add(addDisposableListener(save, EventType.CLICK, () => this.saveAndCheckoutBranch(this.blockedCheckoutBranchName!)));
			this.renderDisposables.add(addDisposableListener(dismiss, EventType.CLICK, () => {
				this.problemMessage = undefined;
				this.blockedCheckoutBranchName = undefined;
				this.render();
			}));

			actions.append(save, dismiss);
			problem.append(actions);
		}

		return problem;
	}

	private renderTree(): HTMLElement {
		const tree = $('.designer-branch-switcher__tree');
		tree.setAttribute('role', 'menu');

		if (this.treeRenderDeferred) {
			tree.append($('.designer-branch-switcher__empty', undefined, localize('designerBranchSwitcherPreparingBranches', "Preparing branches...")));
			return tree;
		}

		const filteredTree = this.getFilteredTree();

		if (!filteredTree.length) {
			tree.append($('.designer-branch-switcher__empty', undefined, localize('designerBranchSwitcherEmpty', "No branches found.")));
			return tree;
		}

		for (const node of filteredTree) {
			this.renderTreeNode(tree, node, 0);
		}

		return tree;
	}

	private renderRepoList(): HTMLElement {
		const list = $('.designer-branch-switcher__repo-list');

		if (this.refreshingRepos && !this.repoState) {
			list.append($('.designer-branch-switcher__empty', undefined, localize('designerRepoSwitcherLoading', "Loading repos...")));
			return list;
		}

		const repos = this.repoState?.repos ?? [];
		if (!repos.length) {
			list.append($('.designer-branch-switcher__empty', undefined, localize('designerRepoSwitcherEmpty', "No repos added yet.")));
			return list;
		}

		for (const repo of repos) {
			list.append(this.renderRepoRow(repo));
		}

		if (this.cloningRepoUrl) {
			const cloningRow = this.renderRepoRow({
				name: this.getRepoNameFromUrl(this.cloningRepoUrl),
				path: '',
				status: 'cloning',
				isCurrent: false,
				url: this.cloningRepoUrl
			});
			list.append(cloningRow);
		}

		return list;
	}

	private renderRepoRow(repo: DesignerRepoItem): HTMLElement {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = `designer-branch-switcher__repo-row designer-branch-switcher__repo-row--${repo.status}`;
		row.disabled = repo.status !== 'ready' || !!this.switchingRepoPath;

		const icon = repo.status === 'cloning'
			? $('span.codicon.codicon-loading.codicon-modifier-spin.designer-branch-switcher__row-icon')
			: repo.status === 'problem'
				? $('span.codicon.codicon-error.designer-branch-switcher__row-icon')
				: $('span.codicon.codicon-repo.designer-branch-switcher__row-icon');

		row.append(
			icon,
			$('span.designer-branch-switcher__row-label', undefined, repo.name),
			$('span.designer-branch-switcher__badge', undefined, this.getRepoBadge(repo))
		);

		if (repo.isCurrent) {
			row.classList.add('designer-branch-switcher__repo-row--current');
			row.append($('span.codicon.codicon-check.designer-branch-switcher__row-check'));
		} else if (repo.path === this.switchingRepoPath) {
			row.classList.add('designer-branch-switcher__repo-row--switching');
			row.append($('span.codicon.codicon-sync.codicon-modifier-spin.designer-branch-switcher__row-check'));
		} else if (repo.status === 'ready') {
			this.renderDisposables.add(addDisposableListener(row, EventType.CLICK, () => this.switchRepo(repo.path)));
		}

		if (repo.message) {
			row.title = repo.message;
		} else if (repo.path) {
			row.title = repo.path;
		}

		return row;
	}

	private getRepoBadge(repo: DesignerRepoItem): string {
		if (repo.status === 'cloning') {
			return localize('designerRepoSwitcherCloningBadge', "cloning");
		}

		if (repo.status === 'problem') {
			return localize('designerRepoSwitcherProblemBadge', "problem");
		}

		return repo.isCurrent ? localize('designerRepoSwitcherCurrentBadge', "current") : '';
	}

	private renderFilter(): HTMLElement {
		const wrapper = $('.designer-branch-switcher__filter');
		wrapper.append($('span.codicon.codicon-search.designer-branch-switcher__filter-icon'));

		const input = document.createElement('input');
		input.className = 'designer-branch-switcher__filter-input';
		input.type = 'text';
		input.value = this.branchFilter;
		input.placeholder = localize('designerBranchSwitcherFilterPlaceholder', "Search branches");
		input.setAttribute('aria-label', localize('designerBranchSwitcherFilterAria', "Search branches"));
		this.filterInput = input;

		this.renderDisposables.add(addDisposableListener(input, EventType.INPUT, () => {
			this.branchFilter = input.value;
			this.render();
			this.focusFilterInput();
		}));

		wrapper.append(input);
		return wrapper;
	}

	private getFilteredTree(): readonly DesignerBranchTreeNode[] {
		const query = this.branchFilter.trim().toLowerCase();
		if (!query) {
			return this.state?.tree ?? [];
		}

		return this.filterTree(this.state?.tree ?? [], query);
	}

	private filterTree(nodes: readonly DesignerBranchTreeNode[], query: string): DesignerBranchTreeNode[] {
		const result: DesignerBranchTreeNode[] = [];

		for (const node of nodes) {
			const children = this.filterTree(node.children, query);
			const branchMatches = node.branch ? this.branchMatchesFilter(node.branch, query) : false;
			const folderMatches = node.name.toLowerCase().includes(query);

			if (branchMatches || folderMatches || children.length > 0) {
				result.push({
					...node,
					children: folderMatches ? node.children : children
				});
			}
		}

		return result;
	}

	private branchMatchesFilter(branch: DesignerBranchItem, query: string): boolean {
		return branch.name.toLowerCase().includes(query) ||
			branch.path.some(segment => segment.toLowerCase().includes(query));
	}

	private renderTreeNode(parent: HTMLElement, node: DesignerBranchTreeNode, depth: number): void {
		if (node.branch) {
			parent.append(this.renderBranchRow(node.branch, depth));
		} else {
			const folder = $('.designer-branch-switcher__folder');
			folder.style.paddingLeft = `${6 + depth * 14}px`;
			folder.append(
				$('span.codicon.codicon-folder.designer-branch-switcher__folder-icon'),
				$('span', undefined, node.name)
			);
			parent.append(folder);
		}

		for (const child of node.children) {
			this.renderTreeNode(parent, child, depth + 1);
		}
	}

	private renderBranchRow(branch: DesignerBranchItem, depth: number): HTMLElement {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = `designer-branch-switcher__row designer-branch-switcher__row--${branch.status}`;
		row.style.paddingLeft = `${6 + depth * 14}px`;
		row.setAttribute('role', 'menuitemradio');
		row.setAttribute('aria-checked', String(branch.isCurrent));
		row.disabled = !!this.switchingBranchName;

		const displayName = branch.path[branch.path.length - 1] ?? branch.name;
		row.append(
			$('span.codicon.codicon-git-branch.designer-branch-switcher__row-icon'),
			$('span.designer-branch-switcher__row-label', undefined, displayName),
			this.renderBranchBadge(branch)
		);

		if (branch.isCurrent) {
			row.classList.add('designer-branch-switcher__row--current');
			row.append($('span.codicon.codicon-check.designer-branch-switcher__row-check'));
			this.currentBranchRow = row;
		} else if (branch.name === this.switchingBranchName) {
			row.classList.add('designer-branch-switcher__row--switching');
			row.append($('span.codicon.codicon-sync.codicon-modifier-spin.designer-branch-switcher__row-check'));
		} else {
			this.renderDisposables.add(addDisposableListener(row, EventType.CLICK, () => this.checkoutBranch(branch.name)));
		}

		return row;
	}

	private renderBranchBadge(branch: DesignerBranchItem): HTMLElement {
		const badgeText = branch.name === this.switchingBranchName
			? localize('designerBranchSwitcherSwitchingBadge', "switching")
			: branch.isDefault
				? localize('designerBranchSwitcherDefaultBadge', "default")
				: branch.status === 'remoteOnly'
					? localize('designerBranchSwitcherRemoteBadge', "cloud")
					: branch.status === 'localOnly'
						? localize('designerBranchSwitcherLocalBadge', "local")
						: branch.status === 'problem'
							? localize('designerBranchSwitcherProblemBadge', "needs sync")
							: '';

		return $('span.designer-branch-switcher__badge', undefined, badgeText);
	}

	private async checkoutBranch(branchName: string): Promise<void> {
		return this.saveAndCheckoutBranch(branchName);
	}

	private async saveAndCheckoutBranch(branchName: string): Promise<void> {
		this.switchingBranchName = branchName;
		this.problemMessage = undefined;
		this.render();

		try {
			const result = await this.commandService.executeCommand<DesignerBranchCheckoutResult>('_designerBranches.saveAndCheckout', { branchName });
			if (!result) {
				throw new Error(localize('designerBranchSwitcherSaveAndCheckoutFailed', "Branch could not be saved and switched."));
			}

			this.state = result.state;

			if (result.blocked) {
				this.problemMessage = result.blocked.message;
				this.blockedCheckoutBranchName = branchName;
			} else {
				this.blockedCheckoutBranchName = undefined;
				this.dropdownMode = undefined;
				this.windowDisposables.clear();
			}
		} catch (error) {
			this.problemMessage = getErrorMessage(error);
			this.blockedCheckoutBranchName = branchName;
		} finally {
			this.switchingBranchName = undefined;
			this.render();
		}
	}

	private async switchRepo(repoPath: string): Promise<void> {
		this.switchingRepoPath = repoPath;
		this.repoProblemMessage = undefined;
		this.render();

		try {
			const result = await this.commandService.executeCommand<DesignerRepoSwitchResult>('_designerRepos.switch', { repoPath });
			if (!result) {
				throw new Error(localize('designerRepoSwitcherSwitchFailed', "Repo could not be opened."));
			}

			this.repoState = result.state;
			if (result.blocked) {
				this.repoProblemMessage = result.blocked.message;
			} else {
				this.dropdownMode = undefined;
				this.windowDisposables.clear();
			}
		} catch (error) {
			this.repoProblemMessage = getErrorMessage(error);
		} finally {
			this.switchingRepoPath = undefined;
			this.render();
		}
	}

	private renderNewBranch(): HTMLElement {
		const form = document.createElement('form');
		form.className = 'designer-branch-switcher__new';

		const prefix = document.createElement('button');
		prefix.className = 'designer-branch-switcher__prefix';
		prefix.type = 'button';
		prefix.textContent = this.useDesignPrefix ? 'design/' : localize('designerBranchSwitcherNoPrefix', "root");
		prefix.title = this.useDesignPrefix
			? localize('designerBranchSwitcherRemovePrefix', "Create outside design/")
			: localize('designerBranchSwitcherAddPrefix', "Create inside design/");

		const input = document.createElement('input');
		input.className = 'designer-branch-switcher__input';
		input.type = 'text';
		input.placeholder = localize('designerBranchSwitcherNewBranchPlaceholder', "new-branch-name");
		input.setAttribute('aria-label', localize('designerBranchSwitcherNewBranchAria', "New branch name"));

		const create = document.createElement('button');
		create.className = 'designer-branch-switcher__create';
		create.type = 'submit';
		create.disabled = true;
		create.append(
			$('span.codicon.codicon-add'),
			$('span', undefined, localize('designerBranchSwitcherCreateBranch', "Create"))
		);

		form.append(prefix, input, create);

		if (!this.useDesignPrefix) {
			form.append($('.designer-branch-switcher__prefix-warning', undefined, localize('designerBranchSwitcherPrefixWarning', "Creates at the branch root. Keep design work grouped when possible.")));
		}

		this.renderDisposables.add(addDisposableListener(prefix, EventType.CLICK, () => {
			this.useDesignPrefix = !this.useDesignPrefix;
			this.render();
		}));

		const updateCreateButtonState = () => {
			create.disabled = !this.getBranchName(input.value);
		};

		this.renderDisposables.add(addDisposableListener(input, EventType.INPUT, updateCreateButtonState));
		updateCreateButtonState();

		this.renderDisposables.add(addDisposableListener(form, EventType.SUBMIT, event => {
			event.preventDefault();
			if (create.disabled) {
				return;
			}
			this.createBranch(input.value);
		}));

		return form;
	}

	private async createBranch(input: string): Promise<void> {
		const branchName = this.getBranchName(input);
		if (!branchName) {
			this.problemMessage = localize('designerBranchSwitcherBranchNameRequired', "Enter a branch name.");
			this.render();
			return;
		}

		this.switchingBranchName = branchName;
		this.problemMessage = undefined;
		this.render();

		try {
			this.state = await this.commandService.executeCommand<DesignerBranchState>('_designerBranches.create', { branchName });
			this.dropdownMode = undefined;
			this.windowDisposables.clear();
		} catch (error) {
			this.problemMessage = getErrorMessage(error);
		} finally {
			this.switchingBranchName = undefined;
			this.render();
		}
	}

	private isBusy(): boolean {
		return this.refreshingBranches || this.refreshingRepos || !!this.switchingBranchName || !!this.switchingRepoPath || !!this.cloningRepoUrl;
	}

	private getBranchName(input: string): string {
		const branchName = input
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9/_-]+/g, '-')
			.replace(/\/+/g, '/')
			.replace(/^-+|-+$/g, '')
			.replace(/^\/+|\/+$/g, '');

		if (!branchName) {
			return '';
		}

		if (!this.useDesignPrefix) {
			return branchName;
		}

		return `design/${branchName.replace(/^design\//, '')}`;
	}

	private renderAddRepo(): HTMLElement {
		const form = document.createElement('form');
		form.className = 'designer-branch-switcher__repo-add-form';

		const input = document.createElement('input');
		input.className = 'designer-branch-switcher__repo-url-input';
		input.type = 'text';
		input.placeholder = localize('designerRepoSwitcherUrlPlaceholder', "Paste repo URL");
		input.setAttribute('aria-label', localize('designerRepoSwitcherUrlAria', "Repository URL"));
		this.repoUrlInput = input;

		const add = document.createElement('button');
		add.className = 'designer-branch-switcher__repo-add';
		add.type = 'submit';
		add.disabled = true;
		add.append(
			$('span.codicon.codicon-add'),
			$('span', undefined, localize('designerRepoSwitcherAdd', "Add"))
		);

		form.append(input, add);

		const updateAddButtonState = () => {
			add.disabled = !input.value.trim() || !!this.cloningRepoUrl;
		};

		this.renderDisposables.add(addDisposableListener(input, EventType.INPUT, updateAddButtonState));
		updateAddButtonState();

		this.renderDisposables.add(addDisposableListener(form, EventType.SUBMIT, event => {
			event.preventDefault();
			const repoUrl = input.value.trim();
			if (!repoUrl || add.disabled) {
				return;
			}
			this.cloneRepo(repoUrl);
		}));

		return form;
	}

	private async cloneRepo(url: string): Promise<void> {
		this.cloningRepoUrl = url;
		this.repoProblemMessage = undefined;
		this.render();

		try {
			this.repoState = await this.commandService.executeCommand<DesignerRepoState>('_designerRepos.clone', { url });
		} catch (error) {
			this.repoProblemMessage = getErrorMessage(error);
		} finally {
			this.cloningRepoUrl = undefined;
			this.render();
			this.focusRepoUrlInput();
		}
	}

	private getRepoNameFromUrl(url: string): string {
		const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
		const lastSegment = trimmed.split(/[/:]/).filter(Boolean).pop();
		if (!lastSegment) {
			return localize('designerRepoSwitcherUnknownRepo', "New repo");
		}

		return lastSegment
			.replace(/[-_]+/g, ' ')
			.replace(/\b\w/g, value => value.toUpperCase());
	}
}
