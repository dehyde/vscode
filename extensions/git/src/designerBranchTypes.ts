/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type DesignerBranchStatus = 'synced' | 'remoteOnly' | 'localOnly' | 'problem';

export interface DesignerBranchRef {
	readonly name: string;
	readonly type: 'local' | 'remote';
	readonly remote?: string;
	readonly commit?: string;
	readonly upstream?: {
		readonly remote: string;
		readonly name: string;
	};
}

export interface DesignerBranchItem {
	readonly name: string;
	readonly path: readonly string[];
	readonly status: DesignerBranchStatus;
	readonly localName?: string;
	readonly remoteName?: string;
	readonly remote?: string;
	readonly isCurrent: boolean;
	readonly isDefault: boolean;
}

export interface DesignerBranchTreeNode {
	readonly name: string;
	readonly path: readonly string[];
	readonly branch?: DesignerBranchItem;
	readonly children: readonly DesignerBranchTreeNode[];
}

export interface DesignerBranchState {
	readonly projectName: string;
	readonly defaultBranch: string | undefined;
	readonly currentBranch: string | undefined;
	readonly syncState: 'synced' | 'syncing' | 'problem';
	readonly branches: readonly DesignerBranchItem[];
	readonly tree: readonly DesignerBranchTreeNode[];
}

export interface DesignerBranchCheckoutResult {
	readonly state: DesignerBranchState;
	readonly blocked?: {
		readonly reason: 'dirtyWorkTree' | 'worktreeBranchAlreadyUsed' | 'branchNameRequired' | 'saveFailed';
		readonly message: string;
	};
}

export type DesignerRepoStatus = 'ready' | 'cloning' | 'problem';

export interface DesignerRepoItem {
	readonly name: string;
	readonly path: string;
	readonly status: DesignerRepoStatus;
	readonly isCurrent: boolean;
	readonly url?: string;
	readonly message?: string;
}

export interface DesignerRepoState {
	readonly currentRepoPath: string | undefined;
	readonly repos: readonly DesignerRepoItem[];
}

export interface DesignerRepoSwitchResult {
	readonly state: DesignerRepoState;
	readonly blocked?: {
		readonly reason: 'branchNameRequired' | 'saveFailed';
		readonly message: string;
	};
}
