/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { mergeDesignerKnownRepos } from '../designerRepoModel';

suite('Designer Repo Model', () => {
	test('keeps current repo when switching to another repo', () => {
		const repos = mergeDesignerKnownRepos({
			currentRepo: { path: '/work/current', name: 'current' },
			storedRepos: [],
			discoveredRepos: [
				{ path: '/work/managed/target', name: 'target' }
			],
			repoToInclude: { path: '/work/managed/target', name: 'target' },
			hiddenRepoPaths: []
		});

		assert.deepStrictEqual(repos.map(repo => repo.path), [
			'/work/current',
			'/work/managed/target'
		]);
	});
});
