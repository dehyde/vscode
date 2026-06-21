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
	private problemMessage: string | undefined;
	private blockedCheckoutBranchName: string | undefined;
	private dropdownVisible = false;
	private loading = false;
	private useDesignPrefix = true;

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

		this.render();
		this.refresh();
	}

	private async toggleDropdown(): Promise<void> {
		this.dropdownVisible = !this.dropdownVisible;

		if (this.dropdownVisible) {
			await this.refresh();
			this.installWindowListeners();
		} else {
			this.windowDisposables.clear();
		}

		this.render();
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

		this.windowDisposables.add(addDisposableListener(targetWindow.document, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				this.dropdownVisible = false;
				this.windowDisposables.clear();
				this.render();
			}
		}));
	}

	private async refresh(): Promise<void> {
		this.loading = true;
		this.problemMessage = undefined;
		this.blockedCheckoutBranchName = undefined;
		this.render();

		try {
			this.state = await this.commandService.executeCommand<DesignerBranchState>('_designerBranches.getState');
		} catch (error) {
			this.problemMessage = getErrorMessage(error);
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private render(): void {
		this.renderDisposables.clear();
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

		this.dropdown.append(this.renderTree(), this.renderNewBranch());
	}

	private renderSyncIcon(): HTMLElement {
		const syncState = this.problemMessage ? 'problem' : this.state?.syncState ?? 'syncing';
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

		if (!this.state?.tree.length) {
			tree.append($('.designer-branch-switcher__empty', undefined, localize('designerBranchSwitcherEmpty', "No branches found.")));
			return tree;
		}

		for (const node of this.state.tree) {
			this.renderTreeNode(tree, node, 0);
		}

		return tree;
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
		this.loading = true;
		this.problemMessage = undefined;
		this.blockedCheckoutBranchName = undefined;
		this.render();

		try {
			const result = await this.commandService.executeCommand<DesignerBranchCheckoutResult>('_designerBranches.checkout', { branchName });
			if (!result) {
				throw new Error(localize('designerBranchSwitcherCheckoutFailed', "Branch could not be switched."));
			}

			this.state = result.state;

			if (result.blocked) {
				this.problemMessage = result.blocked.message;
				this.blockedCheckoutBranchName = branchName;
			} else {
				this.dropdownVisible = false;
				this.windowDisposables.clear();
			}
		} catch (error) {
			this.problemMessage = getErrorMessage(error);
		} finally {
			this.loading = false;
			this.render();
		}
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

		this.renderDisposables.add(addDisposableListener(form, EventType.SUBMIT, event => {
			event.preventDefault();
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

		if (!this.useDesignPrefix) {
			return branchName;
		}

		return `design/${branchName.replace(/^design\//, '')}`;
	}
}
