/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { distinct } from '../../../../base/common/arrays.js';
import { Promises } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isString } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { IExtensionRecommendationNotificationService, IExtensionRecommendations, RecommendationsNotificationResult, RecommendationSource, RecommendationSourceToString } from '../../../../platform/extensionRecommendations/common/extensionRecommendations.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IExtension, IExtensionsWorkbenchService } from '../common/extensions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { EnablementState, IWorkbenchExtensionManagementService, IWorkbenchExtensionEnablementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionIgnoredRecommendationsService } from '../../../services/extensionRecommendations/common/extensionRecommendations.js';
import { ILogService } from '../../../../platform/log/common/log.js';

type ExtensionRecommendationsNotificationClassification = {
	owner: 'sandy081';
	comment: 'Response information when an extension is recommended';
	userReaction: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'User reaction after showing the recommendation prompt. Eg., install, cancel, show, neverShowAgain' };
	extensionId?: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'Id of the extension that is recommended' };
	source: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The source from which this recommendation is coming from. Eg., file, exe.,' };
};

type ExtensionWorkspaceRecommendationsNotificationClassification = {
	owner: 'sandy081';
	comment: 'Response information when a recommendation from workspace is recommended';
	userReaction: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'User reaction after showing the recommendation prompt. Eg., install, cancel, show, neverShowAgain' };
};

const ignoreImportantExtensionRecommendationStorageKey = 'extensionsAssistant/importantRecommendationsIgnore';
const donotShowWorkspaceRecommendationsStorageKey = 'extensionsAssistant/workspaceRecommendationsIgnore';

type RecommendationsNotificationActions = {
	onDidInstallRecommendedExtensions(extensions: IExtension[]): void;
	onDidCancelRecommendedExtensions(extensions: IExtension[]): void;
};

type ExtensionRecommendations = Omit<IExtensionRecommendations, 'extensions'> & { extensions: Array<string | URI> };

export class ExtensionRecommendationNotificationService extends Disposable implements IExtensionRecommendationNotificationService {

	declare readonly _serviceBrand: undefined;

	// Ignored Important Recommendations
	get ignoredRecommendations(): string[] {
		return distinct([...(<string[]>JSON.parse(this.storageService.get(ignoreImportantExtensionRecommendationStorageKey, StorageScope.PROFILE, '[]')))].map(i => i.toLowerCase()));
	}

	private recommendedExtensions: string[] = [];

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IWorkbenchExtensionEnablementService private readonly extensionEnablementService: IWorkbenchExtensionEnablementService,
		@IExtensionIgnoredRecommendationsService private readonly extensionIgnoredRecommendationsService: IExtensionIgnoredRecommendationsService,
		@IWorkbenchEnvironmentService private readonly workbenchEnvironmentService: IWorkbenchEnvironmentService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	hasToIgnoreRecommendationNotifications(): boolean {
		const config = this.configurationService.getValue<{ ignoreRecommendations: boolean; showRecommendationsOnlyOnDemand?: boolean }>('extensions');
		return config.ignoreRecommendations || !!config.showRecommendationsOnlyOnDemand;
	}

	async promptImportantExtensionsInstallNotification(extensionRecommendations: IExtensionRecommendations): Promise<RecommendationsNotificationResult> {
		const ignoredRecommendations = [...this.extensionIgnoredRecommendationsService.ignoredRecommendations, ...this.ignoredRecommendations];
		const extensions = extensionRecommendations.extensions.filter(id => !ignoredRecommendations.includes(id));
		if (!extensions.length) {
			return RecommendationsNotificationResult.Ignored;
		}

		return this.promptRecommendationsNotification({ ...extensionRecommendations, extensions }, {
			onDidInstallRecommendedExtensions: (extensions: IExtension[]) => extensions.forEach(extension => this.telemetryService.publicLog2<{ userReaction: string; extensionId: string; source: string }, ExtensionRecommendationsNotificationClassification>('extensionRecommendations:popup', { userReaction: 'install', extensionId: extension.identifier.id, source: RecommendationSourceToString(extensionRecommendations.source) })),
			onDidCancelRecommendedExtensions: (extensions: IExtension[]) => extensions.forEach(extension => this.telemetryService.publicLog2<{ userReaction: string; extensionId: string; source: string }, ExtensionRecommendationsNotificationClassification>('extensionRecommendations:popup', { userReaction: 'cancelled', extensionId: extension.identifier.id, source: RecommendationSourceToString(extensionRecommendations.source) })),
		});
	}

	async promptWorkspaceRecommendations(recommendations: Array<string | URI>): Promise<void> {
		if (this.storageService.getBoolean(donotShowWorkspaceRecommendationsStorageKey, StorageScope.WORKSPACE, false)) {
			return;
		}

		let installed = await this.extensionManagementService.getInstalled();
		installed = installed.filter(l => this.extensionEnablementService.getEnablementState(l) !== EnablementState.DisabledByExtensionKind); // Filter extensions disabled by kind
		recommendations = recommendations.filter(recommendation => installed.every(local =>
			isString(recommendation) ? !areSameExtensions({ id: recommendation }, local.identifier) : !this.uriIdentityService.extUri.isEqual(recommendation, local.location)
		));
		if (!recommendations.length) {
			return;
		}

		await this.promptRecommendationsNotification({ extensions: recommendations, source: RecommendationSource.WORKSPACE, name: localize({ key: 'this repository', comment: ['this repository means the current repository that is opened'] }, "this repository") }, {
			onDidInstallRecommendedExtensions: () => this.telemetryService.publicLog2<{ userReaction: string }, ExtensionWorkspaceRecommendationsNotificationClassification>('extensionWorkspaceRecommendations:popup', { userReaction: 'install' }),
			onDidCancelRecommendedExtensions: () => this.telemetryService.publicLog2<{ userReaction: string }, ExtensionWorkspaceRecommendationsNotificationClassification>('extensionWorkspaceRecommendations:popup', { userReaction: 'cancelled' }),
		});

	}

	private async promptRecommendationsNotification({ extensions: extensionIds, source }: ExtensionRecommendations, recommendationsNotificationActions: RecommendationsNotificationActions): Promise<RecommendationsNotificationResult> {

		if (this.hasToIgnoreRecommendationNotifications()) {
			return RecommendationsNotificationResult.Ignored;
		}

		// Do not show exe based recommendations in remote window
		if (source === RecommendationSource.EXE && this.workbenchEnvironmentService.remoteAuthority) {
			return RecommendationsNotificationResult.IncompatibleWindow;
		}

		if (source === RecommendationSource.EXE && extensionIds.every(id => isString(id) && this.recommendedExtensions.includes(id))) {
			return RecommendationsNotificationResult.Ignored;
		}

		const extensions = await this.getInstallableExtensions(extensionIds);
		if (!extensions.length) {
			return RecommendationsNotificationResult.Ignored;
		}

		this.recommendedExtensions = distinct([...this.recommendedExtensions, ...extensionIds.filter(isString)]);

		const installed = await this.installRecommendedExtensions(extensions, recommendationsNotificationActions);
		return installed ? RecommendationsNotificationResult.Accepted : RecommendationsNotificationResult.Cancelled;
	}

	private async getInstallableExtensions(recommendations: Array<string | URI>): Promise<IExtension[]> {
		const result: IExtension[] = [];
		if (recommendations.length) {
			const galleryExtensions: string[] = [];
			const resourceExtensions: URI[] = [];
			for (const recommendation of recommendations) {
				if (typeof recommendation === 'string') {
					galleryExtensions.push(recommendation);
				} else {
					resourceExtensions.push(recommendation);
				}
			}
			if (galleryExtensions.length) {
				const extensions = await this.extensionsWorkbenchService.getExtensions(distinct(galleryExtensions.map(id => id.toLowerCase())).map(id => ({ id })), { source: 'install-recommendations' }, CancellationToken.None);
				for (const extension of extensions) {
					if (extension.gallery && await this.extensionManagementService.canInstall(extension.gallery) === true) {
						result.push(extension);
					}
				}
			}
			if (resourceExtensions.length) {
				const extensions = await this.extensionsWorkbenchService.getResourceExtensions(resourceExtensions, true);
				for (const extension of extensions) {
					if (await this.extensionsWorkbenchService.canInstall(extension) === true) {
						result.push(extension);
					}
				}
			}
		}
		return result;
	}

	private async installRecommendedExtensions(extensions: IExtension[], { onDidInstallRecommendedExtensions, onDidCancelRecommendedExtensions }: RecommendationsNotificationActions): Promise<boolean> {
		onDidInstallRecommendedExtensions(extensions);

		const installResults = await Promises.settled(extensions.map(async extension => {
			try {
				if (extension.gallery) {
					await this.extensionManagementService.installGalleryExtensions([{ extension: extension.gallery, options: { isMachineScoped: false } }]);
					return true;
				}
				if (extension.resourceExtension) {
					await this.extensionsWorkbenchService.install(extension);
					return true;
				}
			} catch (error) {
				this.logService.error(`Failed to auto install recommended extension '${extension.identifier.id}'.`, error);
			}
			return false;
		}));

		const installed = installResults.some(result => result === true);
		if (!installed) {
			onDidCancelRecommendedExtensions(extensions);
		}
		return installed;
	}
}
