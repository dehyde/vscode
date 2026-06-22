/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { $ } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ChatContextKeys } from '../../../chat/common/actions/chatContextKeys.js';
import { IBrowserViewModel } from '../../common/browserView.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import {
	BrowserEditor,
	BrowserEditorContribution,
	BrowserWidgetLocation,
	IBrowserEditorWidget,
} from '../browserEditor.js';

/**
 * Welcome placeholder shown in the content area when no URL is loaded; hides
 * as soon as a URL appears and reappears when it's cleared.
 */
export class BrowserWelcomeFeature extends BrowserEditorContribution {

	private readonly _container: HTMLElement;
	private readonly _title: HTMLElement;
	private readonly _subtitle: HTMLElement;
	private readonly _configureButton: HTMLButtonElement;
	private readonly _defaultSubtitle: string;
	private readonly _widget: IBrowserEditorWidget;

	constructor(
		editor: BrowserEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(editor);

		this._container = $('.browser-welcome-container');
		const content = $('.browser-welcome-content');

		const iconContainer = $('.browser-welcome-icon');
		iconContainer.appendChild(renderIcon(Codicon.globe));
		content.appendChild(iconContainer);

		this._title = $('.browser-welcome-title');
		this._title.textContent = localize('browser.welcomeTitle', "Browser");
		content.appendChild(this._title);

		this._subtitle = $('.browser-welcome-subtitle');
		const chatEnabled = contextKeyService.getContextKeyValue<boolean>(ChatContextKeys.enabled.key);
		this._defaultSubtitle = chatEnabled
			? localize('browser.welcomeSubtitleChat', "Use Add Element to Chat to reference UI elements in chat prompts.")
			: localize('browser.welcomeSubtitle', "Enter a URL above to get started.");
		this._subtitle.textContent = this._defaultSubtitle;
		content.appendChild(this._subtitle);

		this._configureButton = document.createElement('button');
		this._configureButton.className = 'browser-welcome-configure-button';
		this._configureButton.textContent = localize('browser.configureAppPreviewUrl', "Configure URL");
		this._configureButton.addEventListener('click', () => {
			void this.commandService.executeCommand('workbench.action.agentSessions.configureAppPreviewUrl');
		});
		content.appendChild(this._configureButton);

		this._container.appendChild(content);

		this._widget = { location: BrowserWidgetLocation.ContentArea, element: this._container, order: 50 };
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [this._widget];
	}

	override prerenderInput(input: BrowserEditorInput): void {
		this._update(input.isSessionAppPreview, !input.url);
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		const isSessionAppPreview = this.editor.input instanceof BrowserEditorInput && this.editor.input.isSessionAppPreview;
		this._update(isSessionAppPreview, !model.url);
		store.add(model.onDidNavigate(event => this._update(isSessionAppPreview, !event.url)));
	}

	override onModelDetached(): void {
		const isSessionAppPreview = this.editor.input instanceof BrowserEditorInput && this.editor.input.isSessionAppPreview;
		this._update(isSessionAppPreview, true);
	}

	private _update(isSessionAppPreview: boolean, visible: boolean): void {
		if (isSessionAppPreview) {
			this._title.textContent = localize('browser.appPreviewWelcomeTitle', "App Preview");
			this._subtitle.textContent = localize('browser.appPreviewWelcomeSubtitle', "Ask the coding agent to start the app. The preview will open when a local app URL appears.");
		} else {
			this._title.textContent = localize('browser.welcomeTitle', "Browser");
			this._subtitle.textContent = this._defaultSubtitle;
		}
		this._configureButton.style.display = isSessionAppPreview ? '' : 'none';
		this._container.style.display = visible ? '' : 'none';
	}
}

BrowserEditor.registerContribution(BrowserWelcomeFeature);
