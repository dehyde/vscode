/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandEvent, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { DesignerBranchSwitcher } from '../../../../browser/parts/designerBranchSwitcher/designerBranchSwitcher.js';

suite('DesignerBranchSwitcher', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('updates from fallback branch label after startup branch state becomes available', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		const commandService = new RetryingBranchCommandService();
		disposables.add(new DesignerBranchSwitcher(parent, commandService));

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__project')?.textContent, 'Project');
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch')?.textContent, 'No branch');

		await timeout(650);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__project')?.textContent, 'VSCode Fork');
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch')?.textContent, 'design/test1');
		assert.ok(commandService.calls >= 2);
	});

	test('renders repo and branch as separate controls', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		disposables.add(new DesignerBranchSwitcher(parent, new DesignerSwitcherCommandService()));

		await timeout(0);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__repo-button')?.textContent?.trim(), 'VSCode Fork');
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__branch-button')?.textContent?.trim(), 'design/test1');
	});

	test('opens branch browser from branch control', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		disposables.add(new DesignerBranchSwitcher(parent, new DesignerSwitcherCommandService()));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__branch-button') as HTMLButtonElement).click();
		await timeout(0);

		assert.ok(parent.querySelector('.designer-branch-switcher__filter-input'));
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__repo-url-input'), null);
	});

	test('opens repo browser from repo control', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		disposables.add(new DesignerBranchSwitcher(parent, new DesignerSwitcherCommandService()));

		await timeout(0);
		(parent.querySelector('.designer-branch-switcher__repo-button') as HTMLButtonElement).click();
		await timeout(0);

		assert.strictEqual(parent.querySelector('.designer-branch-switcher__repo-row')?.textContent?.includes('VSCode Fork'), true);
		assert.ok(parent.querySelector('.designer-branch-switcher__repo-url-input'));
		assert.strictEqual(parent.querySelector('.designer-branch-switcher__filter-input'), null);
	});

	test('clones pasted repo URL from repo browser', async () => {
		const parent = document.createElement('div');
		disposables.add({ dispose: () => parent.remove() });
		document.body.appendChild(parent);

		const commandService = new DesignerSwitcherCommandService();
		disposables.add(new DesignerBranchSwitcher(parent, commandService));

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
