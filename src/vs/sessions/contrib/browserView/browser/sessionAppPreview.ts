/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAllInterfacesAuthority, isLocalhostAuthority } from '../../../../platform/url/common/trustedDomains.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, IReader } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsTasksService } from '../../chat/browser/sessionsTasksService.js';

const URL_PATTERN = /https?:\/\/(?:\[[^\]\s]+\]|[^\s/:]+)(?::\d+)?(?:\/[^\s]*)?/gi;
const PREVIEW_ID_PREFIX = 'session-app-preview-';
const WORKSPACE_PREVIEW_ID_PREFIX = 'session-app-preview-workspace-';

export const ConfigureSessionAppPreviewUrlCommandId = 'workbench.action.agentSessions.configureAppPreviewUrl';

export function extractLocalhostUrls(text: string): string[] {
	const urls: string[] = [];
	for (const match of text.matchAll(URL_PATTERN)) {
		const normalized = normalizeLocalhostUrl(match[0]);
		if (normalized) {
			urls.push(normalized);
		}
	}
	return urls;
}

function normalizeLocalhostUrl(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return undefined;
	}

	if (isAllInterfacesAuthority(url.host)) {
		url.hostname = 'localhost';
		return url.href;
	}

	if (!isLocalhostAuthority(url.host)) {
		return undefined;
	}

	return url.href;
}

function getSessionKey(session: ISession): string {
	return session.resource.toString();
}

function getSessionPreviewId(session: ISession): string {
	return `${PREVIEW_ID_PREFIX}${hash(getSessionKey(session)).toString(16)}`;
}

function getWorkspacePreviewKey(repository: URI): string {
	return `workspace:${repository.toString()}`;
}

function getWorkspacePreviewId(repository: URI): string {
	return `${WORKSPACE_PREVIEW_ID_PREFIX}${hash(repository.toString()).toString(16)}`;
}

function getSessionRepository(session: ISession, reader?: IReader): URI | undefined {
	const workspace = reader ? session.workspace.read(reader) : session.workspace.get();
	return workspace?.folders[0]?.root;
}

function getSessionWorkingDirectory(session: ISession): URI | undefined {
	const folder = session.workspace.get()?.folders[0];
	return folder?.workingDirectory ?? folder?.root;
}

function getWorkspaceRepository(workspaceContextService: IWorkspaceContextService): URI | undefined {
	return workspaceContextService.getWorkspace().folders[0]?.uri;
}

function getUriKey(uri: URI | undefined): string | undefined {
	return uri?.fsPath.toLowerCase();
}

export class SessionAppPreviewController extends Disposable {

	static readonly ID = 'workbench.contrib.sessionAppPreview';

	private readonly _previewsBySession = new Map<string, BrowserEditorInput>();
	private readonly _workspacePreviewKeys = new Set<string>();
	private readonly _discoveredUrlsBySession = new Map<string, string>();
	private readonly _terminalCwdKeys = new Map<number, Promise<string | undefined>>();
	private _lastActivePreviewKey: string | undefined;

	constructor(
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionsTasksService private readonly _sessionsTasksService: ISessionsTasksService,
		@IBrowserViewWorkbenchService private readonly _browserViewService: IBrowserViewWorkbenchService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(autorun(reader => {
			const activeSession = this._sessionsService.activeSession.read(reader);
			if (!activeSession) {
				const repository = getWorkspaceRepository(this._workspaceContextService);
				if (!repository) {
					this._lastActivePreviewKey = undefined;
					return;
				}
				const overrideUrl = this._sessionsTasksService.getBrowserUrl(repository).read(reader);
				const previewKey = getWorkspacePreviewKey(repository);
				const shouldReveal = this._lastActivePreviewKey !== previewKey;
				this._lastActivePreviewKey = previewKey;
				void this._ensureWorkspacePreview(repository, shouldReveal).then(preview => {
					this._navigatePreviewToPreferredUrl(preview, overrideUrl, this._discoveredUrlsBySession.get(previewKey));
				}).catch(error => {
					this._logService.error('[SessionAppPreview] Failed to ensure workspace app preview.', error);
				});
				return;
			}
			if (activeSession.loading.read(reader)) {
				return;
			}

			const repository = getSessionRepository(activeSession, reader);
			const overrideUrl = this._sessionsTasksService.getBrowserUrl(repository).read(reader);
			const sessionKey = getSessionKey(activeSession);
			const shouldReveal = this._lastActivePreviewKey !== sessionKey;
			this._lastActivePreviewKey = sessionKey;
			void this.ensurePreview(activeSession, shouldReveal).then(() => {
				this._navigatePreferredUrl(activeSession, overrideUrl);
			}).catch(error => {
				this._logService.error('[SessionAppPreview] Failed to ensure app preview.', error);
			});
		}));

		this._register(this._terminalService.onAnyInstanceData(e => {
			void this._handleTerminalData(e.instance, e.data).catch(error => {
				this._logService.error('[SessionAppPreview] Failed to inspect terminal output.', error);
			});
		}));
	}

	async ensurePreview(session: ISession, reveal = true): Promise<BrowserEditorInput> {
		this._disposeWorkspacePreviews();

		const sessionKey = getSessionKey(session);
		const existing = this._previewsBySession.get(sessionKey);
		if (existing && !existing.isDisposed()) {
			if (reveal) {
				await this._openPreview(existing);
			}
			return existing;
		}

		const repository = getSessionRepository(session);
		const overrideUrl = this._sessionsTasksService.getBrowserUrl(repository).get();
		const preview = this._browserViewService.getOrCreateLazy(getSessionPreviewId(session), {
			url: overrideUrl,
			title: localize('sessionAppPreviewTitle', "App Preview"),
			isSessionAppPreview: true,
		});

		this._previewsBySession.set(sessionKey, preview);
		this._register(preview.onBeforeDispose(e => {
			if (!preview.isDisposed()) {
				e.veto();
			}
		}));
		this._register(preview.onWillDispose(() => {
			if (this._previewsBySession.get(sessionKey) === preview) {
				this._previewsBySession.delete(sessionKey);
			}
		}));

		await this._openPreview(preview);
		return preview;
	}

	private async _ensureWorkspacePreview(repository: URI, reveal = true): Promise<BrowserEditorInput> {
		const previewKey = getWorkspacePreviewKey(repository);
		const existing = this._previewsBySession.get(previewKey);
		if (existing && !existing.isDisposed()) {
			if (reveal) {
				await this._openPreview(existing);
			}
			return existing;
		}

		const overrideUrl = this._sessionsTasksService.getBrowserUrl(repository).get();
		const preview = this._browserViewService.getOrCreateLazy(getWorkspacePreviewId(repository), {
			url: overrideUrl,
			title: localize('sessionAppPreviewTitle', "App Preview"),
			isSessionAppPreview: true,
		});

		this._previewsBySession.set(previewKey, preview);
		this._workspacePreviewKeys.add(previewKey);
		this._register(preview.onBeforeDispose(e => {
			if (!preview.isDisposed()) {
				e.veto();
			}
		}));
		this._register(preview.onWillDispose(() => {
			if (this._previewsBySession.get(previewKey) === preview) {
				this._previewsBySession.delete(previewKey);
			}
			this._workspacePreviewKeys.delete(previewKey);
		}));

		await this._openPreview(preview);
		return preview;
	}

	getPreview(session: ISession): BrowserEditorInput | undefined {
		return this._previewsBySession.get(getSessionKey(session));
	}

	navigateDiscoveredUrl(session: ISession, url: string): void {
		const sessionKey = getSessionKey(session);
		this._discoveredUrlsBySession.set(sessionKey, url);
		const repository = getSessionRepository(session);
		if (this._sessionsTasksService.getBrowserUrl(repository).get()) {
			return;
		}
		this.getPreview(session)?.navigate(url);
	}

	private _navigateWorkspaceDiscoveredUrl(repository: URI, url: string): void {
		const previewKey = getWorkspacePreviewKey(repository);
		this._discoveredUrlsBySession.set(previewKey, url);
		if (this._sessionsTasksService.getBrowserUrl(repository).get()) {
			return;
		}
		this._previewsBySession.get(previewKey)?.navigate(url);
	}

	refreshFromOverride(session: ISession): void {
		const repository = getSessionRepository(session);
		this._navigatePreferredUrl(session, this._sessionsTasksService.getBrowserUrl(repository).get());
	}

	private async _openPreview(preview: BrowserEditorInput): Promise<void> {
		await this._editorService.openEditor(preview, { pinned: true, index: 0 }, this._editorGroupsService.activeGroup);
	}

	private _navigatePreferredUrl(session: ISession, overrideUrl: string | undefined): void {
		const url = overrideUrl ?? this._discoveredUrlsBySession.get(getSessionKey(session));
		if (!url) {
			return;
		}
		const preview = this.getPreview(session);
		if (preview?.url !== url) {
			preview?.navigate(url);
		}
	}

	private _navigatePreviewToPreferredUrl(preview: BrowserEditorInput, overrideUrl: string | undefined, discoveredUrl: string | undefined): void {
		const url = overrideUrl ?? discoveredUrl;
		if (url && preview.url !== url) {
			preview.navigate(url);
		}
	}

	private async _handleTerminalData(instance: ITerminalInstance, data: string): Promise<void> {
		const activeSession = this._sessionsService.activeSession.get();
		if (activeSession?.loading.get()) {
			return;
		}

		const workingDirectory = activeSession ? getSessionWorkingDirectory(activeSession) : getWorkspaceRepository(this._workspaceContextService);
		const targetCwdKey = getUriKey(workingDirectory);
		if (!targetCwdKey) {
			return;
		}

		const terminalCwdKey = await this._getTerminalCwdKey(instance);
		if (terminalCwdKey !== targetCwdKey) {
			return;
		}

		const [url] = extractLocalhostUrls(data);
		if (url) {
			if (activeSession) {
				this.navigateDiscoveredUrl(activeSession, url);
			} else if (workingDirectory) {
				this._navigateWorkspaceDiscoveredUrl(workingDirectory, url);
			}
		}
	}

	private _disposeWorkspacePreviews(): void {
		for (const previewKey of [...this._workspacePreviewKeys]) {
			this._previewsBySession.get(previewKey)?.dispose(true);
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

class ConfigureSessionAppPreviewUrlAction extends Action2 {
	constructor() {
		super({
			id: ConfigureSessionAppPreviewUrlCommandId,
			title: localize2('configureSessionAppPreviewUrl', "Configure App Preview URL"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const sessionsService = accessor.get(ISessionsService);
		const sessionsTasksService = accessor.get(ISessionsTasksService);
		const quickInputService = accessor.get(IQuickInputService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const activeSession = sessionsService.activeSession.get();
		const repository = activeSession ? getSessionRepository(activeSession) : getWorkspaceRepository(workspaceContextService);
		if (!repository) {
			return;
		}

		const currentUrl = sessionsTasksService.getBrowserUrl(repository).get();
		const url = await quickInputService.input({
			title: localize('configureAppPreviewUrlTitle', "Configure App Preview URL"),
			prompt: localize('configureAppPreviewUrlPrompt', "Enter the URL to open in the app preview. Leave empty to clear."),
			placeHolder: 'http://localhost:3000',
			value: currentUrl ?? '',
			ignoreFocusLost: true,
		});
		if (url === undefined) {
			return;
		}

		sessionsTasksService.setBrowserUrl(repository, url);
	}
}

registerAction2(ConfigureSessionAppPreviewUrlAction);
