/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface DesignerKnownRepo {
	readonly path: string;
	readonly name: string;
	readonly url?: string;
}

interface MergeDesignerKnownReposOptions {
	readonly currentRepo?: DesignerKnownRepo;
	readonly storedRepos: readonly { readonly path?: string; readonly name?: string; readonly url?: string }[];
	readonly discoveredRepos: readonly DesignerKnownRepo[];
	readonly repoToInclude?: DesignerKnownRepo;
	readonly hiddenRepoPaths: readonly string[];
}

export function mergeDesignerKnownRepos(options: MergeDesignerKnownReposOptions): DesignerKnownRepo[] {
	const repos: DesignerKnownRepo[] = [];

	appendRepo(repos, options.currentRepo, options.hiddenRepoPaths, true);

	for (const repo of options.storedRepos) {
		if (!repo.path) {
			continue;
		}

		appendRepo(repos, {
			path: repo.path,
			name: repo.name || getDesignerRepoLabel(repo.path),
			url: repo.url
		}, options.hiddenRepoPaths, false);
	}

	for (const repo of options.discoveredRepos) {
		appendRepo(repos, repo, options.hiddenRepoPaths, false);
	}

	appendRepo(repos, options.repoToInclude, options.hiddenRepoPaths, false);

	return repos;
}

export function getDesignerRepoLabel(repoPath: string): string {
	return repoPath.split(/[\\/]/).filter(Boolean).at(-1) || repoPath;
}

function appendRepo(repos: DesignerKnownRepo[], repo: DesignerKnownRepo | undefined, hiddenRepoPaths: readonly string[], forceInclude: boolean): void {
	if (!repo?.path) {
		return;
	}

	if (!forceInclude && hiddenRepoPaths.some(hiddenPath => pathEquals(hiddenPath, repo.path))) {
		return;
	}

	const existingIndex = repos.findIndex(existing => pathEquals(existing.path, repo.path));
	if (existingIndex !== -1) {
		const existing = repos[existingIndex];
		repos[existingIndex] = {
			path: existing.path,
			name: existing.name || repo.name,
			url: existing.url ?? repo.url
		};
		return;
	}

	repos.push(repo);
}

function pathEquals(first: string, second: string): boolean {
	return normalizePath(first) === normalizePath(second);
}

function normalizePath(repoPath: string): string {
	return repoPath.replace(/\\/g, '/').toLowerCase();
}
