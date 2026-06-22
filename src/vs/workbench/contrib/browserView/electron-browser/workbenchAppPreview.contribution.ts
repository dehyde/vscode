/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../../base/common/hash.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { extractLocalhostUrls, normalizeHttpUrl } from '../common/appPreviewUrl.js';
import { BrowserEditorInput } from '../common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../common/browserView.js';

const APP_PREVIEW_ID_PREFIX = 'workbench-app-preview-';
const APP_PREVIEW_URL_STORAGE_KEY = 'workbench.appPreview.url';

export const ConfigureWorkbenchAppPreviewUrlCommandId = 'workbench.action.agentSessions.configureAppPreviewUrl';

function getWorkspaceRoot(workspaceContextService: IWorkspaceContextService): URI | undefined {
	return workspaceContextService.getWorkspace().folders[0]?.uri;
}

function getWorkspacePreviewId(root: URI): string {
	return `${APP_PREVIEW_ID_PREFIX}${hash(root.toString()).toString(16)}`;
}

function getUriKey(uri: URI | undefined): string | undefined {
	return uri?.fsPath.toLowerCase();
}

export class WorkbenchAppPreviewController extends Disposable {

	static readonly ID = 'workbench.contrib.workbenchAppPreview';

	private readonly _storageListenerStore = this._register(new DisposableStore());
	private readonly _activeGroupListenerStore = this._register(new DisposableStore());
	private readonly _terminalCwdKeys = new Map<number, Promise<string | undefined>>();
	private _preview: BrowserEditorInput | undefined;
	private _discoveredUrl: string | undefined;
	private _workspaceRootKey: string | undefined;

	constructor(
		@IBrowserViewWorkbenchService private readonly _browserViewService: IBrowserViewWorkbenchService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(this._storageService.onDidChangeValue(StorageScope.WORKSPACE, APP_PREVIEW_URL_STORAGE_KEY, this._storageListenerStore)(() => {
			this.refreshFromOverride();
		}));

		this._register(this._terminalService.onAnyInstanceData(e => {
			void this._handleTerminalData(e.instance, e.data).catch(error => {
				this._logService.error('[WorkbenchAppPreview] Failed to inspect terminal output.', error);
			});
		}));

		this._register(this._editorGroupsService.onDidChangeActiveGroup(() => {
			this._trackActiveGroup();
			void this.ensurePreview(false).catch(error => {
				this._logService.error('[WorkbenchAppPreview] Failed to reveal app preview after active group change.', error);
			});
		}));

		this._trackActiveGroup();
		void this.ensurePreview(true).catch(error => {
			this._logService.error('[WorkbenchAppPreview] Failed to ensure app preview.', error);
		});
	}

	async ensurePreview(reveal: boolean): Promise<BrowserEditorInput | undefined> {
		const root = getWorkspaceRoot(this._workspaceContextService);
		if (!root) {
			return undefined;
		}

		const rootKey = root.toString();
		if (this._workspaceRootKey !== rootKey) {
			this._preview = undefined;
			this._discoveredUrl = undefined;
			this._workspaceRootKey = rootKey;
		}

		if (!this._preview || this._preview.isDisposed()) {
			this._preview = this._browserViewService.getOrCreateLazy(getWorkspacePreviewId(root), {
				url: this._getOverrideUrl(),
				title: localize('workbenchAppPreviewTitle', "App Preview"),
				isSessionAppPreview: true,
			});

			this._register(this._preview.onBeforeDispose(e => {
				if (!this._preview?.isDisposed()) {
					e.veto();
				}
			}));
		}

		const preview = this._preview;
		const activeGroup = this._editorGroupsService.activeGroup;
		const shouldOpen = reveal || activeGroup.getIndexOfEditor(preview) !== 0 || !activeGroup.isPinned(preview);
		if (shouldOpen) {
			const options: IEditorOptions = { pinned: true, index: 0, preserveFocus: !reveal };
			await this._editorService.openEditor(preview, options, activeGroup);
		}

		this._navigatePreferredUrl();
		return preview;
	}

	navigateDiscoveredUrl(url: string): void {
		this._discoveredUrl = url;
		if (this._getOverrideUrl()) {
			return;
		}
		this._preview?.navigate(url);
	}

	refreshFromOverride(): void {
		this._navigatePreferredUrl();
	}

	private _navigatePreferredUrl(): void {
		const url = this._getOverrideUrl() ?? this._discoveredUrl;
		if (url && this._preview?.url !== url) {
			this._preview?.navigate(url);
		}
	}

	private _getOverrideUrl(): string | undefined {
		return this._storageService.get(APP_PREVIEW_URL_STORAGE_KEY, StorageScope.WORKSPACE);
	}

	private _trackActiveGroup(): void {
		this._activeGroupListenerStore.clear();
		this._activeGroupListenerStore.add(this._editorGroupsService.activeGroup.onDidModelChange(() => {
			if (!this._preview || this._preview.isDisposed()) {
				return;
			}

			const activeGroup = this._editorGroupsService.activeGroup;
			if (activeGroup.getIndexOfEditor(this._preview) !== 0 || !activeGroup.isPinned(this._preview)) {
				void this.ensurePreview(false).catch(error => {
					this._logService.error('[WorkbenchAppPreview] Failed to restore app preview tab position.', error);
				});
			}
		}));
	}

	private async _handleTerminalData(instance: ITerminalInstance, data: string): Promise<void> {
		const root = getWorkspaceRoot(this._workspaceContextService);
		const rootKey = getUriKey(root);
		if (!rootKey) {
			return;
		}

		const terminalCwdKey = await this._getTerminalCwdKey(instance);
		if (terminalCwdKey !== rootKey) {
			return;
		}

		const [url] = extractLocalhostUrls(data);
		if (url) {
			await this.ensurePreview(false);
			this.navigateDiscoveredUrl(url);
		}
	}

	private _getTerminalCwdKey(instance: ITerminalInstance): Promise<string | undefined> {
		let cached = this._terminalCwdKeys.get(instance.instanceId);
		if (!cached) {
			cached = instance.getInitialCwd()
				.then(cwd => cwd.toLowerCase())
				.catch(() => undefined);
			this._terminalCwdKeys.set(instance.instanceId, cached);
		}
		return cached;
	}
}

class ConfigureWorkbenchAppPreviewUrlAction extends Action2 {
	constructor() {
		super({
			id: ConfigureWorkbenchAppPreviewUrlCommandId,
			title: localize2('configureWorkbenchAppPreviewUrl', "Configure App Preview URL"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const storageService = accessor.get(IStorageService);
		const quickInputService = accessor.get(IQuickInputService);
		const currentUrl = storageService.get(APP_PREVIEW_URL_STORAGE_KEY, StorageScope.WORKSPACE);
		const url = await quickInputService.input({
			title: localize('configureAppPreviewUrlTitle', "Configure App Preview URL"),
			prompt: localize('configureAppPreviewUrlPrompt', "Enter the URL to open in the app preview. Leave empty to clear."),
			placeHolder: 'http://localhost:3000',
			value: currentUrl ?? '',
			ignoreFocusLost: true,
			validateInput: async value => {
				if (!value.trim()) {
					return undefined;
				}
				return normalizeHttpUrl(value.trim()) ? undefined : localize('invalidAppPreviewUrl', "Enter a valid http or https URL.");
			}
		});
		if (url === undefined) {
			return;
		}

		const normalized = normalizeHttpUrl(url.trim());
		if (normalized) {
			storageService.store(APP_PREVIEW_URL_STORAGE_KEY, normalized, StorageScope.WORKSPACE, StorageTarget.USER);
		} else {
			storageService.remove(APP_PREVIEW_URL_STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}
}

registerAction2(ConfigureWorkbenchAppPreviewUrlAction);
registerWorkbenchContribution2(WorkbenchAppPreviewController.ID, WorkbenchAppPreviewController, WorkbenchPhase.AfterRestored);
