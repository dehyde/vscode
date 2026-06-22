/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './designerBranchSwitcher.css';
import { $, addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
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

export class DesignerBranchSwitcher extends Disposable {

	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly windowDisposables = this._register(new DisposableStore());
	private readonly container: HTMLElement;
	private readonly button: HTMLButtonElement;
	private readonly dropdown: HTMLElement;

	private state: DesignerBranchState | undefined;
	private filterInput: HTMLInputElement | undefined;
	private currentBranchRow: HTMLElement | undefined;
	private problemMessage: string | undefined;
	private blockedCheckoutBranchName: string | undefined;
	private dropdownVisible = false;
	private loading = false;
	private refreshPromise: Promise<void> | undefined;
	private useDesignPrefix = true;
	private branchFilter = '';
	private pointerDownInsideDropdown = false;

	constructor(
		parent: HTMLElement,
		@ICommandService private readonly commandService: ICommandService
	) {
		super();

		this.container = $('.designer-branch-switcher');
		this.button = document.createElement('button');
		this.button.className = 'designer-branch-switcher__button';
		this.button.type = 'button';
		this.button.setAttribute('aria-haspopup', 'menu');

		this.dropdown = $('.designer-branch-switcher__dropdown');
		this.dropdown.hidden = true;

		this.container.append(this.button, this.dropdown);
		parent.appendChild(this.container);

		this._register(addDisposableListener(this.button, EventType.CLICK, () => this.toggleDropdown()));
		this._register(addDisposableListener(this.dropdown, EventType.MOUSE_DOWN, () => {
			this.pointerDownInsideDropdown = true;
			getWindow(this.container).setTimeout(() => this.pointerDownInsideDropdown = false, 1000);
		}, true));
		this._register(addDisposableListener(this.container, EventType.FOCUS_OUT, event => this.closeDropdownIfFocusMovedOutside(event as FocusEvent), true));

		this.render();
		this.refresh();
	}

	private async toggleDropdown(): Promise<void> {
		this.dropdownVisible = !this.dropdownVisible;

		if (this.dropdownVisible) {
			this.branchFilter = '';
			this.installWindowListeners();
			this.refresh({ updateRemotes: true });
		} else {
			this.windowDisposables.clear();
		}

		this.render();
		this.focusFilterInput();
		this.scrollCurrentBranchIntoView();
	}

	private focusFilterInput(): void {
		if (!this.dropdownVisible) {
			return;
		}

		getWindow(this.container).requestAnimationFrame(() => {
			this.filterInput?.focus({ preventScroll: true });
			this.filterInput?.setSelectionRange(this.filterInput.value.length, this.filterInput.value.length);
		});
	}

	private scrollCurrentBranchIntoView(): void {
		if (!this.dropdownVisible) {
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
				this.dropdownVisible = false;
				this.windowDisposables.clear();
				this.render();
			}
		}));

		this.windowDisposables.add(addDisposableListener(targetWindow.document, EventType.FOCUS_IN, event => {
			if (!this.container.contains(event.target as Node)) {
				this.closeDropdown();
			}
		}, true));

		this.windowDisposables.add(addDisposableListener(targetWindow.document, EventType.FOCUS_OUT, event => this.closeDropdownIfFocusMovedOutside(event as FocusEvent), true));

		this.windowDisposables.add(addDisposableListener(targetWindow, EventType.BLUR, () => this.closeDropdownIfDocumentFocusMovedOutside()));

		this.windowDisposables.add(addDisposableListener(targetWindow.document, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				this.closeDropdown();
			}
		}));
	}

	private closeDropdown(): void {
		this.dropdownVisible = false;
		this.windowDisposables.clear();
		this.render();
	}

	private closeDropdownIfFocusMovedOutside(event: FocusEvent): void {
		const targetWindow = getWindow(this.container);
		const relatedTarget = event.relatedTarget;
		if (relatedTarget instanceof targetWindow.Node && !this.container.contains(relatedTarget)) {
			this.closeDropdown();
			return;
		}

		targetWindow.setTimeout(() => this.closeDropdownIfDocumentFocusMovedOutside(), 0);
	}

	private closeDropdownIfDocumentFocusMovedOutside(): void {
		if (!this.dropdownVisible) {
			return;
		}

		if (this.loading || this.pointerDownInsideDropdown) {
			return;
		}

		if (!this.container.contains(getWindow(this.container).document.activeElement)) {
			this.closeDropdown();
		}
	}

	private refresh(options: { updateRemotes?: boolean } = {}): void {
		if (this.refreshPromise) {
			return;
		}

		this.loading = true;
		this.problemMessage = undefined;
		this.blockedCheckoutBranchName = undefined;
		this.render();

		this.refreshPromise = this.doRefresh(options)
			.finally(() => {
				this.refreshPromise = undefined;
				this.loading = false;
				this.render();
				this.focusFilterInput();
				this.scrollCurrentBranchIntoView();
			});
	}

	private async doRefresh(options: { updateRemotes?: boolean }): Promise<void> {
		try {
			this.state = await this.commandService.executeCommand<DesignerBranchState>('_designerBranches.getState', { updateRemotes: options.updateRemotes === true });
		} catch (error) {
			this.problemMessage = getErrorMessage(error);
		}
	}

	private render(): void {
		this.renderDisposables.clear();
		this.filterInput = undefined;
		this.currentBranchRow = undefined;
		this.button.replaceChildren();
		this.dropdown.replaceChildren();
		this.dropdown.hidden = !this.dropdownVisible;
		this.button.setAttribute('aria-expanded', String(this.dropdownVisible));

		const projectName = this.state?.projectName ?? localize('designerBranchSwitcherProjectFallback', "Project");
		const branchName = this.state?.currentBranch ?? this.state?.defaultBranch ?? localize('designerBranchSwitcherNoBranch', "No branch");

		const label = $('.designer-branch-switcher__label');
		label.append(
			$('span.designer-branch-switcher__project', undefined, projectName),
			$('span.designer-branch-switcher__separator', undefined, ':'),
			$('span.designer-branch-switcher__branch', undefined, branchName)
		);

		this.button.append(
			label,
			this.renderSyncIcon(),
			$('span.codicon.codicon-chevron-down.designer-branch-switcher__chevron')
		);

		if (!this.dropdownVisible) {
			return;
		}

		if (this.problemMessage) {
			this.dropdown.append(this.renderProblem(this.problemMessage));
		}

		if (this.loading && !this.state) {
			this.dropdown.append($('.designer-branch-switcher__empty', undefined, localize('designerBranchSwitcherLoading', "Loading branches...")));
			return;
		}

		this.dropdown.append(this.renderFilter(), this.renderTree(), this.renderNewBranch());
	}

	private renderSyncIcon(): HTMLElement {
		const syncState = this.problemMessage ? 'problem' : this.loading ? 'syncing' : this.state?.syncState ?? 'syncing';
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
			? localize('designerBranchSwitcherSyncing', "Syncing")
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
			folder.style.setProperty('--designer-branch-depth', String(depth));
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
		row.style.setProperty('--designer-branch-depth', String(depth));
		row.setAttribute('role', 'menuitemradio');
		row.setAttribute('aria-checked', String(branch.isCurrent));

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
		} else {
			this.renderDisposables.add(addDisposableListener(row, EventType.CLICK, () => this.checkoutBranch(branch.name)));
		}

		return row;
	}

	private renderBranchBadge(branch: DesignerBranchItem): HTMLElement {
		const badgeText = branch.isDefault
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
		this.loading = true;
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
				this.dropdownVisible = false;
				this.windowDisposables.clear();
			}
		} catch (error) {
			this.problemMessage = getErrorMessage(error);
			this.blockedCheckoutBranchName = branchName;
		} finally {
			this.loading = false;
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

		this.loading = true;
		this.problemMessage = undefined;
		this.render();

		try {
			this.state = await this.commandService.executeCommand<DesignerBranchState>('_designerBranches.create', { branchName });
			this.dropdownVisible = false;
			this.windowDisposables.clear();
		} catch (error) {
			this.problemMessage = getErrorMessage(error);
		} finally {
			this.loading = false;
			this.render();
		}
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
}
