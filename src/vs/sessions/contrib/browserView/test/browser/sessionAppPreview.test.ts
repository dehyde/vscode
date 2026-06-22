/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService, ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { BrowserEditorInput, IBeforeDisposeBrowserEditorEvent } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { IChat, ISessionFolder, ISessionWorkspace, SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsTasksService } from '../../../chat/browser/sessionsTasksService.js';
import { extractLocalhostUrls, SessionAppPreviewController } from '../../browser/sessionAppPreview.js';

function tick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

function makeSession(opts: { sessionId?: string; resource?: URI; repository?: URI; worktree?: URI; loading?: boolean } = {}): IActiveSession {
	const repository = opts.repository ?? URI.file('/repo');
	const folder = {
		root: repository,
		workingDirectory: opts.worktree ?? repository,
		name: 'test',
		description: undefined,
		gitRepository: { uri: repository, workTreeUri: opts.worktree, baseBranchName: undefined, gitHubInfo: constObservable(undefined) },
	} satisfies ISessionFolder;
	const chat: IChat = {
		resource: opts.resource ?? URI.parse('file:///session'),
		createdAt: new Date(),
		title: observableValue('title', 'session'),
		updatedAt: observableValue('updatedAt', new Date()),
		status: observableValue('status', SessionStatus.Untitled),
		changes: observableValue('changes', []),
		modelId: observableValue('modelId', undefined),
		mode: observableValue('mode', undefined),
		isArchived: observableValue('isArchived', false),
		isRead: observableValue('isRead', true),
		checkpoints: observableValue('checkpoints', undefined),
		lastTurnEnd: observableValue('lastTurnEnd', undefined),
		description: observableValue('description', undefined),
	} satisfies IChat;
	return {
		sessionId: opts.sessionId ?? 'test:session',
		resource: chat.resource,
		providerId: 'test',
		sessionType: 'background',
		icon: Codicon.copilot,
		createdAt: chat.createdAt,
		workspace: observableValue('workspace', {
			uri: repository,
			label: 'test',
			icon: Codicon.repo,
			folders: [folder],
			requiresWorkspaceTrust: false,
			isVirtualWorkspace: false
		} satisfies ISessionWorkspace),
		title: chat.title,
		updatedAt: chat.updatedAt,
		status: chat.status,
		changesets: constObservable([]),
		changes: chat.changes,
		modelId: chat.modelId,
		mode: chat.mode,
		loading: observableValue('loading', opts.loading ?? false),
		isArchived: chat.isArchived,
		isRead: chat.isRead,
		lastTurnEnd: chat.lastTurnEnd,
		description: chat.description,
		chats: observableValue('chats', [chat]),
		activeChat: observableValue('activeChat', chat),
		mainChat: constObservable(chat),
		capabilities: { supportsMultipleChats: false },
		isCreated: observableValue('isCreated', true),
		sticky: observableValue('sticky', false),
	} satisfies IActiveSession;
}

class TestPreviewInput {
	private readonly _onBeforeDispose = new Emitter<IBeforeDisposeBrowserEditorEvent>();
	readonly onBeforeDispose = this._onBeforeDispose.event;
	private readonly _onWillDispose = new Emitter<void>();
	readonly onWillDispose = this._onWillDispose.event;
	readonly isSessionAppPreview = true;
	private _disposed = false;
	url: string | undefined;
	navigations: string[] = [];

	constructor(readonly id: string, initialUrl: string | undefined) {
		this.url = initialUrl;
	}

	isDisposed(): boolean {
		return this._disposed;
	}

	navigate(url: string): void {
		this.url = url;
		this.navigations.push(url);
	}

	dispose(force?: boolean): void {
		if (!force) {
			let vetoed = false;
			this._onBeforeDispose.fire({ veto: () => { vetoed = true; } });
			if (vetoed) {
				return;
			}
		}
		this._disposed = true;
		this._onWillDispose.fire();
	}
}

suite('Session App Preview', () => {

	test('extractLocalhostUrls finds localhost dev server URLs', () => {
		assert.deepStrictEqual(
			extractLocalhostUrls('  Local:   http://localhost:5173/'),
			['http://localhost:5173/']
		);
	});

	test('extractLocalhostUrls returns multiple localhost URLs in order', () => {
		assert.deepStrictEqual(
			extractLocalhostUrls('ready on http://localhost:3000 and http://127.0.0.1:3001/app'),
			['http://localhost:3000/', 'http://127.0.0.1:3001/app']
		);
	});

	test('extractLocalhostUrls ignores non-localhost URLs', () => {
		assert.deepStrictEqual(
			extractLocalhostUrls('ready on https://example.com and http://vscode.dev'),
			[]
		);
	});

	test('extractLocalhostUrls normalizes all-interface URLs to localhost', () => {
		assert.deepStrictEqual(
			extractLocalhostUrls('Network: http://0.0.0.0:4173/ and http://[::]:4174'),
			['http://localhost:4173/', 'http://localhost:4174/']
		);
	});

	suite('SessionAppPreviewController', () => {
		const store = new DisposableStore();
		let activeSession: ReturnType<typeof observableValue<IActiveSession | undefined>>;
		let terminalData: Emitter<{ instance: ITerminalInstance; data: string }>;
		let previews: TestPreviewInput[];
		let opened: { editor: TestPreviewInput; options: { pinned?: boolean; index?: number } | undefined; group: unknown }[];
		let browserUrls: Map<string, ReturnType<typeof observableValue<string | undefined>>>;
		const activeGroup = { id: 1 };
		const workspaceRepository = URI.file('/repo');

		function activePreviews(): TestPreviewInput[] {
			return previews.filter(preview => !preview.isDisposed());
		}

		setup(() => {
			activeSession = observableValue('activeSession', undefined);
			terminalData = store.add(new Emitter<{ instance: ITerminalInstance; data: string }>());
			previews = [];
			opened = [];
			browserUrls = new Map();

			const instantiationService = store.add(new TestInstantiationService());
			instantiationService.stub(ISessionsService, new class extends mock<ISessionsService>() {
				override readonly activeSession = activeSession;
			});
			instantiationService.stub(IWorkspaceContextService, new class extends mock<IWorkspaceContextService>() {
				override getWorkspace(): any {
					return {
						id: 'workspace',
						folders: [{ uri: workspaceRepository, name: 'repo', index: 0 }],
					};
				}
				override getWorkbenchState(): WorkbenchState {
					return WorkbenchState.FOLDER;
				}
			});
			instantiationService.stub(ISessionsTasksService, new class extends mock<ISessionsTasksService>() {
				override getBrowserUrl(repository: URI | undefined) {
					const key = repository?.toString() ?? 'none';
					let value = browserUrls.get(key);
					if (!value) {
						value = observableValue('browserUrl', undefined);
						browserUrls.set(key, value);
					}
					return value;
				}
				override setBrowserUrl(repository: URI | undefined, url: string | undefined): void {
					this.getBrowserUrl(repository).set(url, undefined);
				}
			});
			instantiationService.stub(IBrowserViewWorkbenchService, new class extends mock<IBrowserViewWorkbenchService>() {
				override getOrCreateLazy(id: string, initialState?: { url?: string }): BrowserEditorInput {
					let preview = previews.find(p => p.id === id);
					if (!preview) {
						preview = new TestPreviewInput(id, initialState?.url);
						previews.push(preview);
					}
					return preview as unknown as BrowserEditorInput;
				}
			});
			instantiationService.stub(IEditorService, new class extends mock<IEditorService>() {
				override async openEditor(editor: any, options?: any, group?: unknown): Promise<any> {
					opened.push({ editor: editor as unknown as TestPreviewInput, options, group });
					return undefined;
				}
			});
			instantiationService.stub(IEditorGroupsService, new class extends mock<IEditorGroupsService>() {
				override get activeGroup(): any { return activeGroup; }
			});
			instantiationService.stub(ITerminalService, new class extends mock<ITerminalService>() {
				override readonly onAnyInstanceData = terminalData.event;
			});
			instantiationService.stub(ILogService, new NullLogService());
			store.add(instantiationService.createInstance(SessionAppPreviewController));
		});

		teardown(() => {
			store.clear();
		});

		test('creates a pinned workspace preview at index zero when no session is active yet', async () => {
			await tick();

			assert.strictEqual(activePreviews().length, 1);
			assert.strictEqual(opened.length, 1);
			assert.strictEqual(opened[0].options?.pinned, true);
			assert.strictEqual(opened[0].options?.index, 0);
			assert.strictEqual(opened[0].group, activeGroup);
		});

		test('creates and reuses one pinned preview at index zero for a session', async () => {
			await tick();
			const session = makeSession();
			activeSession.set(session, undefined);
			await tick();
			activeSession.set(session, undefined);
			await tick();

			const [preview] = activePreviews();
			assert.ok(preview);
			assert.strictEqual(activePreviews().length, 1);
			assert.strictEqual(opened.length, 2);
			assert.strictEqual(opened[1].editor, preview);
			assert.strictEqual(opened[1].options?.pinned, true);
			assert.strictEqual(opened[1].options?.index, 0);
			assert.strictEqual(opened[1].group, activeGroup);
		});

		test('vetoes normal close attempts for the app preview', async () => {
			await tick();
			activeSession.set(makeSession(), undefined);
			await tick();

			const [preview] = activePreviews();
			preview.dispose();

			assert.strictEqual(preview.isDisposed(), false);
		});

		test('navigates to a discovered localhost URL from the active session terminal cwd', async () => {
			await tick();
			const session = makeSession({ worktree: URI.file('/worktree') });
			activeSession.set(session, undefined);
			await tick();

			terminalData.fire({
				instance: { instanceId: 1, getInitialCwd: () => Promise.resolve('/worktree') } as unknown as ITerminalInstance,
				data: 'Local: http://localhost:5173/'
			});
			await tick();

			assert.deepStrictEqual(activePreviews()[0].navigations, ['http://localhost:5173/']);
		});

		test('does not navigate to a discovered URL when an override is configured', async () => {
			await tick();
			const repository = URI.file('/repo');
			const session = makeSession({ repository, worktree: URI.file('/worktree') });
			browserUrls.set(repository.toString(), observableValue('browserUrl', 'http://localhost:3000/'));
			activeSession.set(session, undefined);
			await tick();

			terminalData.fire({
				instance: { instanceId: 1, getInitialCwd: () => Promise.resolve('/worktree') } as unknown as ITerminalInstance,
				data: 'Local: http://localhost:5173/'
			});
			await tick();

			const [preview] = activePreviews();
			assert.strictEqual(preview.url, 'http://localhost:3000/');
			assert.deepStrictEqual(preview.navigations, []);
		});
	});
});
