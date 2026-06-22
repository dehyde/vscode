/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandEvent, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { IWorkspaceTrustRequestService, WorkspaceTrustRequestOptions, WorkspaceTrustUriResponse } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { DesignerBranchSwitcher } from '../../../../browser/parts/designerBranchSwitcher/designerBranchSwitcher.js';

suite('DesignerBranchSwitcher', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createSwitcher(parent: HTMLElement, commandService: ICommandService, dialogService = new TestDialogService(), trustService: IWorkspaceTrustRequestService = new StaticWorkspaceTrustRequestService(true)): DesignerBranchSwitcher {
		return new DesignerBranchSwitcher(parent, commandService, dialogService, trustService);
	}

	test('updates from fallback branch label after startup branch state becomes available', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		const commandService = new RetryingBranchCommandService();
		disposables.add(createSwitcher(parent, commandService));

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__project')?.textContent, 'Project');
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch')?.textContent, 'No branch');

		await timeout(650);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__project')?.textContent, 'VSCode Fork');
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch')?.textContent, 'design/test1');
		assert.ok(commandService.calls >= 2);
	});

	test('retries quietly while startup repository state is still loading', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		const commandService = new LoadingRepositoryCommandService();
		disposables.add(createSwitcher(parent, commandService));

		await timeout(0);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__project')?.textContent, 'repo-a');
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch')?.textContent, 'No branch');

		await timeout(650);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__project')?.textContent, 'repo-a');
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch')?.textContent, 'main');
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__problem'), null);
		assert.ok(commandService.branchCalls >= 2);
	});

	test('renders repo and branch as separate controls', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		disposables.add(createSwitcher(parent, new DesignerSwitcherCommandService()));

		await timeout(0);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__repo-button')?.textContent?.trim(), 'VSCode Fork');
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch-button')?.textContent?.trim(), 'design/test1');
	});

	test('updates branch control from live git branch state', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		disposables.add(createSwitcher(parent, new DesignerSwitcherCommandService()));

		await timeout(0);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch-button')?.textContent?.includes('design/test1'), true);

		CommandsRegistry.getCommand('_designerBranches.didChangeState')?.handler(undefined!, {
			projectName: 'VSCode Fork',
			defaultBranch: 'main',
			currentBranch: 'design/live-update',
			syncState: 'synced',
			repositoryReady: true,
			branches: [],
			tree: []
		});

		await timeout(0);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch-button')?.textContent?.includes('design/live-update'), true);
	});

	test('sizes repo control to its content instead of a fixed share', async () => {
		const parent = document.createElement('div');
		parent.style.position = 'absolute';
		parent.style.width = '420px';
		parent.style.height = '34px';
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		disposables.add(createSwitcher(parent, new DesignerSwitcherCommandService()));

		await timeout(0);

		const repoButton = parent.querySelector('.designer-branch-switcher__repo-button') as HTMLButtonElement;
		const branchButton = parent.querySelector('.designer-branch-switcher__branch-button') as HTMLButtonElement;
		const repoRect = repoButton.getBoundingClientRect();
		const branchRect = branchButton.getBoundingClientRect();

		assert.ok(repoRect.width < 150, `Expected repo control to fit content, got ${repoRect.width}px`);
		assert.ok(branchRect.left - repoRect.right < 12, 'Expected branch control to stay adjacent to repo control');
	});

	test('opens branch browser from branch control', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		disposables.add(createSwitcher(parent, new DesignerSwitcherCommandService()));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__branch-button') as HTMLButtonElement).click();
		await timeout(20);

		assert.ok(parent.querySelector('.designer-branch-switcher__filter-input'));
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__repo-url-input'), null);
	});

	test('keeps branch browser open through transient focus loss while opening', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		disposables.add(createSwitcher(parent, new DesignerSwitcherCommandService()));

		await timeout(0);
		const branchButton = parent.querySelector('.designer-branch-switcher__branch-button') as HTMLButtonElement;
		branchButton.focus();
		branchButton.click();
		branchButton.blur();
		branchButton.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
		await timeout(20);

		assert.ok(parent.querySelector('.designer-branch-switcher__filter-input'));
		assert.strictEqual(branchButton.getAttribute('aria-expanded'), 'true');
	});

	test('opens repo browser from repo control', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		disposables.add(createSwitcher(parent, new DesignerSwitcherCommandService()));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__repo-button') as HTMLButtonElement).click();
		await timeout(0);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__repo-row')?.textContent?.includes('VSCode Fork'), true);
		assert.ok(parent.querySelector('.designer-branch-switcher__repo-url-input'));
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__filter-input'), null);
	});

	test('shows immediate save state when switching branches', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		const commandService = new SlowBranchSwitchCommandService();
		disposables.add(createSwitcher(parent, commandService));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__branch-button') as HTMLButtonElement).click();
		await timeout(20);

		const mainBranch = [...parent.querySelectorAll('.designer-branch-switcher__row')]
			.find(row => row.textContent?.includes('main')) as HTMLButtonElement;
		mainBranch.click();
		await timeout(0);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch-button')?.textContent?.includes('Saving'), true);
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__row--switching')?.textContent?.includes('saving'), true);

		commandService.resolveSwitch();
		await timeout(0);
	});

	test('keeps branch dropdown open with recovery actions when cloud save is blocked', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		disposables.add(createSwitcher(parent, new BlockedBranchSwitchCommandService()));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__branch-button') as HTMLButtonElement).click();
		await timeout(20);

		const mainBranch = [...parent.querySelectorAll('.designer-branch-switcher__row')]
			.find(row => row.textContent?.includes('main')) as HTMLButtonElement;
		mainBranch.click();
		await timeout(0);

		assert.ok(parent.querySelector('.designer-branch-switcher__filter-input'));
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__problem')?.textContent?.includes('Could not save to cloud'), true);
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__problem-action--retry')?.textContent, 'Retry save');
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__problem-action--switch')?.textContent, 'Switch without saving');
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__problem-action--copy')?.textContent, 'Copy issue for agent');
	});

	test('switch without saving uses explicit branch bypass command', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		const commandService = new BlockedBranchSwitchCommandService();
		disposables.add(createSwitcher(parent, commandService));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__branch-button') as HTMLButtonElement).click();
		await timeout(20);

		const mainBranch = [...parent.querySelectorAll('.designer-branch-switcher__row')]
			.find(row => row.textContent?.includes('main')) as HTMLButtonElement;
		mainBranch.click();
		await timeout(0);

		const switchWithoutSaving = parent.querySelector('.designer-branch-switcher__problem-action--switch') as HTMLButtonElement;
		assert.ok(switchWithoutSaving);
		switchWithoutSaving.click();
		await timeout(0);

		assert.deepStrictEqual(commandService.checkoutWithoutSavingRequests, ['main']);
	});

	test('repo switch uses save-first command and shows immediate save state', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		const commandService = new SlowRepoSwitchCommandService();
		disposables.add(createSwitcher(parent, commandService));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__repo-button') as HTMLButtonElement).click();
		await timeout(0);

		const targetRepo = [...parent.querySelectorAll('.designer-branch-switcher__repo-row')]
			.find(row => row.textContent?.includes('Other Repo')) as HTMLButtonElement;
		targetRepo.click();
		await timeout(0);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch-button')?.textContent?.includes('Saving'), true);
		assert.deepStrictEqual(commandService.saveAndSwitchRequests, ['/workspace/other-repo']);

		commandService.resolveSwitch();
		await timeout(0);
	});

	test('clones pasted repo URL from repo browser', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		const commandService = new DesignerSwitcherCommandService();
		disposables.add(createSwitcher(parent, commandService));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__repo-button') as HTMLButtonElement).click();
		await timeout(0);

		const input = parent.querySelector('.designer-branch-switcher__repo-url-input') as HTMLInputElement;
		input.value = 'https://github.com/workplan/design-system.git';
		input.dispatchEvent(new InputEvent('input', { bubbles: true }));
		(parent.querySelector('.designer-branch-switcher__repo-add') as HTMLButtonElement).click();
		await timeout(10);

		assert.deepStrictEqual(commandService.cloneUrls, ['https://github.com/workplan/design-system.git']);
		assert.strictEqual([...parent.querySelectorAll('.designer-branch-switcher__repo-row')].some(row => row.textContent?.includes('Design System')), true);
	});

	test('keeps existing repos visible when adding another repo', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		disposables.add(createSwitcher(parent, new ReplacingCloneRepoCommandService()));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__repo-button') as HTMLButtonElement).click();
		await timeout(0);

		const input = parent.querySelector('.designer-branch-switcher__repo-url-input') as HTMLInputElement;
		input.value = 'https://github.com/workplan/new-repo.git';
		input.dispatchEvent(new InputEvent('input', { bubbles: true }));
		(parent.querySelector('.designer-branch-switcher__repo-add') as HTMLButtonElement).click();
		await timeout(10);

		const repoRows = [...parent.querySelectorAll('.designer-branch-switcher__repo-row')].map(row => row.textContent ?? '');
		assert.strictEqual(repoRows.some(row => row.includes('Current Repo')), true);
		assert.strictEqual(repoRows.some(row => row.includes('Existing Repo')), true);
		assert.strictEqual(repoRows.some(row => row.includes('New Repo')), true);
	});

	test('removes repo from list after confirmation', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		const commandService = new RemovableRepoCommandService();
		disposables.add(createSwitcher(parent, commandService));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__repo-button') as HTMLButtonElement).click();
		await timeout(0);

		(parent.querySelector('.designer-branch-switcher__repo-remove') as HTMLButtonElement).click();
		await timeout(10);

		assert.deepStrictEqual(commandService.removeRequests, [{ repoPath: '/workspace/old-repo', deleteLocalFiles: false }]);
		const repoRows = [...parent.querySelectorAll('.designer-branch-switcher__repo-row')].map(row => row.textContent ?? '');
		assert.strictEqual(repoRows.some(row => row.includes('Old Repo')), false);
	});

	test('can remove repo and delete local files after confirmation', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		const commandService = new RemovableRepoCommandService();
		const dialogService = new TestDialogService(undefined, { result: 'delete' });
		disposables.add(createSwitcher(parent, commandService, dialogService));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__repo-button') as HTMLButtonElement).click();
		await timeout(0);

		(parent.querySelector('.designer-branch-switcher__repo-remove') as HTMLButtonElement).click();
		await timeout(10);

		assert.deepStrictEqual(commandService.removeRequests, [{ repoPath: '/workspace/old-repo', deleteLocalFiles: true }]);
	});

	test('shows project access action when designer git commands are unavailable', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		const commandService = new RestrictedModeCommandService();
		const trustService = new RecordingWorkspaceTrustRequestService(() => commandService.trusted = true);
		disposables.add(createSwitcher(parent, commandService, new TestDialogService(), trustService));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__branch-button') as HTMLButtonElement).click();
		await timeout(20);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__problem')?.textContent?.includes('Project access is limited'), true);
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__problem-action--trust')?.textContent, 'Allow this project');

		(parent.querySelector('.designer-branch-switcher__problem-action--trust') as HTMLButtonElement).click();
		await timeout(20);

		assert.strictEqual(trustService.requests, 1);
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch-button')?.textContent?.includes('design/test1'), true);
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__problem'), null);
	});
});

class RetryingBranchCommandService implements ICommandService {
	declare readonly _serviceBrand: undefined;

	private readonly _onWillExecuteCommand = new Emitter<ICommandEvent>();
	readonly onWillExecuteCommand: Event<ICommandEvent> = this._onWillExecuteCommand.event;

	private readonly _onDidExecuteCommand = new Emitter<ICommandEvent>();
	readonly onDidExecuteCommand: Event<ICommandEvent> = this._onDidExecuteCommand.event;

	private _calls = 0;
	get calls(): number {
		return this._calls;
	}

	async executeCommand<T>(commandId: string): Promise<T | undefined> {
		this._calls++;

		if (commandId !== '_designerBranches.getState') {
			throw new Error(`Unexpected command: ${commandId}`);
		}

		if (this._calls === 1) {
			throw new Error('Git repository is not ready yet.');
		}

		return {
			projectName: 'VSCode Fork',
			defaultBranch: 'main',
			currentBranch: 'design/test1',
			syncState: 'synced',
			branches: [],
			tree: []
		} as T;
	}
}

class LoadingRepositoryCommandService implements ICommandService {
	declare readonly _serviceBrand: undefined;

	private readonly _onWillExecuteCommand = new Emitter<ICommandEvent>();
	readonly onWillExecuteCommand: Event<ICommandEvent> = this._onWillExecuteCommand.event;

	private readonly _onDidExecuteCommand = new Emitter<ICommandEvent>();
	readonly onDidExecuteCommand: Event<ICommandEvent> = this._onDidExecuteCommand.event;

	private _calls = 0;
	get calls(): number {
		return this._calls;
	}
	private _branchCalls = 0;
	get branchCalls(): number {
		return this._branchCalls;
	}

	async executeCommand<T>(commandId: string): Promise<T | undefined> {
		this._calls++;

		if (commandId !== '_designerBranches.getState' && commandId !== '_designerRepos.getState') {
			throw new Error(`Unexpected command: ${commandId}`);
		}

		if (commandId === '_designerRepos.getState') {
			return {
				currentRepoPath: '/workspace/repo-a',
				repos: [
					{ name: 'repo-a', path: '/workspace/repo-a', status: 'ready', isCurrent: true },
				]
			} as T;
		}

		this._branchCalls++;

		if (this._branchCalls === 1) {
			return {
				projectName: 'repo-a',
				defaultBranch: undefined,
				currentBranch: undefined,
				syncState: 'syncing',
				repositoryReady: false,
				branches: [],
				tree: []
			} as T;
		}

		return {
			projectName: 'repo-a',
			defaultBranch: 'main',
			currentBranch: 'main',
			syncState: 'synced',
			repositoryReady: true,
			branches: [],
			tree: []
		} as T;
	}
}

class DesignerSwitcherCommandService implements ICommandService {
	declare readonly _serviceBrand: undefined;

	private readonly _onWillExecuteCommand = new Emitter<ICommandEvent>();
	readonly onWillExecuteCommand: Event<ICommandEvent> = this._onWillExecuteCommand.event;

	private readonly _onDidExecuteCommand = new Emitter<ICommandEvent>();
	readonly onDidExecuteCommand: Event<ICommandEvent> = this._onDidExecuteCommand.event;

	readonly cloneUrls: string[] = [];

	async executeCommand<T>(commandId: string, ...args: unknown[]): Promise<T | undefined> {
		if (commandId === '_designerBranches.getState') {
			return {
				projectName: 'VSCode Fork',
				defaultBranch: 'main',
				currentBranch: 'design/test1',
				syncState: 'synced',
				branches: [
					{ name: 'main', path: ['main'], status: 'synced', isCurrent: false, isDefault: true },
					{ name: 'design/test1', path: ['design', 'test1'], status: 'synced', isCurrent: true, isDefault: false },
				],
				tree: [
					{ name: 'main', path: ['main'], branch: { name: 'main', path: ['main'], status: 'synced', isCurrent: false, isDefault: true }, children: [] },
					{ name: 'design', path: ['design'], children: [{ name: 'test1', path: ['design', 'test1'], branch: { name: 'design/test1', path: ['design', 'test1'], status: 'synced', isCurrent: true, isDefault: false }, children: [] }] },
				]
			} as T;
		}

		if (commandId === '_designerRepos.getState') {
			return {
				currentRepoPath: '/workspace/vscode-fork',
				repos: [
					{ name: 'VSCode Fork', path: '/workspace/vscode-fork', status: 'ready', isCurrent: true },
				]
			} as T;
		}

		if (commandId === '_designerRepos.clone') {
			this.cloneUrls.push((args[0] as { url: string }).url);
			return {
				currentRepoPath: '/workspace/vscode-fork',
				repos: [
					{ name: 'VSCode Fork', path: '/workspace/vscode-fork', status: 'ready', isCurrent: true },
					{ name: 'Design System', path: '/workspace/design-system', status: 'ready', isCurrent: false },
				]
			} as T;
		}

		throw new Error(`Unexpected command: ${commandId}`);
	}
}

class SlowBranchSwitchCommandService extends DesignerSwitcherCommandService {

	private switchResolver: (() => void) | undefined;

	resolveSwitch(): void {
		this.switchResolver?.();
	}

	override async executeCommand<T>(commandId: string, ...args: unknown[]): Promise<T | undefined> {
		if (commandId === '_designerBranches.saveAndCheckout') {
			await new Promise<void>(resolve => this.switchResolver = resolve);
			const branchName = (args[0] as { branchName: string }).branchName;
			return {
				state: this.createBranchState(branchName),
				sync: {
					state: 'synced',
					targetBranch: branchName
				}
			} as T;
		}

		return super.executeCommand(commandId, ...args);
	}

	protected createBranchState(currentBranch: string): unknown {
		return {
			projectName: 'VSCode Fork',
			defaultBranch: 'main',
			currentBranch,
			syncState: 'synced',
			branches: [
				{ name: 'main', path: ['main'], status: 'synced', isCurrent: currentBranch === 'main', isDefault: true },
				{ name: 'design/test1', path: ['design', 'test1'], status: 'synced', isCurrent: currentBranch === 'design/test1', isDefault: false },
			],
			tree: [
				{ name: 'main', path: ['main'], branch: { name: 'main', path: ['main'], status: 'synced', isCurrent: currentBranch === 'main', isDefault: true }, children: [] },
				{ name: 'design', path: ['design'], children: [{ name: 'test1', path: ['design', 'test1'], branch: { name: 'design/test1', path: ['design', 'test1'], status: 'synced', isCurrent: currentBranch === 'design/test1', isDefault: false }, children: [] }] },
			]
		};
	}
}

class BlockedBranchSwitchCommandService extends SlowBranchSwitchCommandService {

	readonly checkoutWithoutSavingRequests: string[] = [];

	override async executeCommand<T>(commandId: string, ...args: unknown[]): Promise<T | undefined> {
		if (commandId === '_designerBranches.saveAndCheckout') {
			const branchName = (args[0] as { branchName: string }).branchName;
			return {
				state: this.createBranchState('design/test1'),
				blocked: {
					reason: 'pushRejected',
					message: 'Could not save to cloud'
				},
				sync: {
					state: 'blocked',
					message: 'Could not save to cloud',
					previousBranch: 'design/test1',
					targetBranch: branchName,
					agentPrompt: 'Resolve push rejection for design/test1'
				}
			} as T;
		}

		if (commandId === '_designerBranches.checkout') {
			this.checkoutWithoutSavingRequests.push((args[0] as { branchName: string; skipSave: boolean }).branchName);
			return {
				state: this.createBranchState((args[0] as { branchName: string }).branchName),
				sync: {
					state: 'synced'
				}
			} as T;
		}

		return super.executeCommand(commandId, ...args);
	}
}

class SlowRepoSwitchCommandService extends DesignerSwitcherCommandService {

	readonly saveAndSwitchRequests: string[] = [];
	private switchResolver: (() => void) | undefined;

	resolveSwitch(): void {
		this.switchResolver?.();
	}

	override async executeCommand<T>(commandId: string, ...args: unknown[]): Promise<T | undefined> {
		if (commandId === '_designerRepos.getState') {
			return {
				currentRepoPath: '/workspace/vscode-fork',
				repos: [
					{ name: 'VSCode Fork', path: '/workspace/vscode-fork', status: 'ready', isCurrent: true },
					{ name: 'Other Repo', path: '/workspace/other-repo', status: 'ready', isCurrent: false },
				]
			} as T;
		}

		if (commandId === '_designerRepos.saveAndSwitch') {
			const repoPath = (args[0] as { repoPath: string }).repoPath;
			this.saveAndSwitchRequests.push(repoPath);
			await new Promise<void>(resolve => this.switchResolver = resolve);
			return {
				state: {
					currentRepoPath: repoPath,
					repos: [
						{ name: 'VSCode Fork', path: '/workspace/vscode-fork', status: 'ready', isCurrent: false },
						{ name: 'Other Repo', path: '/workspace/other-repo', status: 'ready', isCurrent: true },
					]
				},
				sync: {
					state: 'synced',
					targetRepoPath: repoPath
				}
			} as T;
		}

		return super.executeCommand(commandId, ...args);
	}
}

class ReplacingCloneRepoCommandService extends DesignerSwitcherCommandService {

	override async executeCommand<T>(commandId: string, ...args: unknown[]): Promise<T | undefined> {
		if (commandId === '_designerRepos.getState') {
			return {
				currentRepoPath: '/workspace/current-repo',
				repos: [
					{ name: 'Current Repo', path: '/workspace/current-repo', status: 'ready', isCurrent: true },
					{ name: 'Existing Repo', path: '/workspace/existing-repo', status: 'ready', isCurrent: false },
				]
			} as T;
		}

		if (commandId === '_designerRepos.clone') {
			this.cloneUrls.push((args[0] as { url: string }).url);
			return {
				currentRepoPath: '/workspace/current-repo',
				repos: [
					{ name: 'New Repo', path: '/workspace/new-repo', status: 'ready', isCurrent: false },
				]
			} as T;
		}

		return super.executeCommand(commandId, ...args);
	}
}

class RemovableRepoCommandService extends DesignerSwitcherCommandService {

	readonly removeRequests: { repoPath: string; deleteLocalFiles: boolean }[] = [];

	override async executeCommand<T>(commandId: string, ...args: unknown[]): Promise<T | undefined> {
		if (commandId === '_designerRepos.getState') {
			return {
				currentRepoPath: '/workspace/current-repo',
				repos: [
					{ name: 'Current Repo', path: '/workspace/current-repo', status: 'ready', isCurrent: true },
					{ name: 'Old Repo', path: '/workspace/old-repo', status: 'ready', isCurrent: false },
				]
			} as T;
		}

		if (commandId === '_designerRepos.remove') {
			const request = args[0] as { repoPath: string; deleteLocalFiles: boolean };
			this.removeRequests.push(request);
			return {
				state: {
					currentRepoPath: '/workspace/current-repo',
					repos: [
						{ name: 'Current Repo', path: '/workspace/current-repo', status: 'ready', isCurrent: true },
					]
				}
			} as T;
		}

		return super.executeCommand(commandId, ...args);
	}
}

class RestrictedModeCommandService extends DesignerSwitcherCommandService {

	trusted = false;

	override async executeCommand<T>(commandId: string, ...args: unknown[]): Promise<T | undefined> {
		if (!this.trusted && (commandId === '_designerBranches.getState' || commandId === '_designerRepos.getState')) {
			throw new Error(`command '${commandId}' not found`);
		}

		return super.executeCommand(commandId, ...args);
	}
}

class StaticWorkspaceTrustRequestService implements IWorkspaceTrustRequestService {
	declare readonly _serviceBrand: undefined;

	readonly onDidInitiateOpenFilesTrustRequest = Event.None;
	readonly onDidInitiateResourcesTrustRequest = Event.None;
	readonly onDidInitiateWorkspaceTrustRequest = Event.None;
	readonly onDidInitiateWorkspaceTrustRequestOnStartup = Event.None;

	constructor(private readonly trusted: boolean) { }

	async requestOpenFilesTrust(): Promise<WorkspaceTrustUriResponse> {
		return WorkspaceTrustUriResponse.Open;
	}

	async completeOpenFilesTrustRequest(): Promise<void> { }

	async completeResourcesTrustRequest(): Promise<void> { }

	async requestResourcesTrust(): Promise<boolean | undefined> {
		return this.trusted;
	}

	cancelWorkspaceTrustRequest(): void { }

	async completeWorkspaceTrustRequest(): Promise<void> { }

	async requestWorkspaceTrust(): Promise<boolean | undefined> {
		return this.trusted;
	}

	requestWorkspaceTrustOnStartup(): void { }
}

class RecordingWorkspaceTrustRequestService extends StaticWorkspaceTrustRequestService {

	requests = 0;

	constructor(private readonly onRequest: () => void) {
		super(false);
	}

	override async requestWorkspaceTrust(options?: WorkspaceTrustRequestOptions): Promise<boolean> {
		this.requests++;
		this.onRequest();
		return true;
	}
}
