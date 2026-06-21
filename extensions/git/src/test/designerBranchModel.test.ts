/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { buildDesignerBranchTree, getDesignerBranchName, mergeDesignerBranchRefs } from '../designerBranchModel';
import { DesignerBranchRef } from '../designerBranchTypes';

suite('Designer Branch Model', () => {
	test('merges matching local and remote branches as synced', () => {
		const refs: DesignerBranchRef[] = [
			{ type: 'local', name: 'design/card', commit: 'abc', upstream: { remote: 'origin', name: 'design/card' } },
			{ type: 'remote', remote: 'origin', name: 'design/card', commit: 'abc' },
		];

		const branches = mergeDesignerBranchRefs(refs, 'origin', 'main', 'design/card');

		assert.strictEqual(branches.length, 1);
		assert.strictEqual(branches[0].name, 'design/card');
		assert.strictEqual(branches[0].status, 'synced');
		assert.strictEqual(branches[0].isCurrent, true);
	});

	test('marks remote-only branches as remoteOnly', () => {
		const refs: DesignerBranchRef[] = [
			{ type: 'remote', remote: 'origin', name: 'design/remote-card', commit: 'def' },
		];

		const branches = mergeDesignerBranchRefs(refs, 'origin', 'main', 'main');

		assert.strictEqual(branches.length, 1);
		assert.strictEqual(branches[0].status, 'remoteOnly');
	});

	test('keeps remote-only branches from non-default remotes', () => {
		const refs: DesignerBranchRef[] = [
			{ type: 'remote', remote: 'workplan', name: 'design/remote-card', commit: 'def' },
		];

		const branches = mergeDesignerBranchRefs(refs, 'origin', 'main', 'main');

		assert.strictEqual(branches.length, 1);
		assert.strictEqual(branches[0].name, 'design/remote-card');
		assert.strictEqual(branches[0].remote, 'workplan');
	});

	test('prefers default remote when the same branch exists on multiple remotes', () => {
		const refs: DesignerBranchRef[] = [
			{ type: 'remote', remote: 'workplan', name: 'design/card', commit: 'def' },
			{ type: 'remote', remote: 'origin', name: 'design/card', commit: 'abc' },
		];

		const branches = mergeDesignerBranchRefs(refs, 'origin', 'main', 'main');

		assert.strictEqual(branches.length, 1);
		assert.strictEqual(branches[0].remote, 'origin');
	});

	test('marks local-only branches as localOnly', () => {
		const refs: DesignerBranchRef[] = [
			{ type: 'local', name: 'design/local-card', commit: 'abc' },
		];

		const branches = mergeDesignerBranchRefs(refs, 'origin', 'main', 'main');

		assert.strictEqual(branches.length, 1);
		assert.strictEqual(branches[0].status, 'localOnly');
	});

	test('pins the default branch before slash-path branches', () => {
		const refs: DesignerBranchRef[] = [
			{ type: 'remote', remote: 'origin', name: 'design/card', commit: 'def' },
			{ type: 'local', name: 'main', commit: 'abc' },
		];

		const branches = mergeDesignerBranchRefs(refs, 'origin', 'main', 'main');

		assert.strictEqual(branches[0].name, 'main');
		assert.strictEqual(branches[0].isDefault, true);
	});

	test('builds slash-separated branches as a tree', () => {
		const branches = mergeDesignerBranchRefs([
			{ type: 'local', name: 'main', commit: 'aaa' },
			{ type: 'remote', remote: 'origin', name: 'design/card', commit: 'bbb' },
			{ type: 'remote', remote: 'origin', name: 'design/modal', commit: 'ccc' },
		], 'origin', 'main', 'main');

		const tree = buildDesignerBranchTree(branches);

		assert.strictEqual(tree[0].name, 'main');
		assert.strictEqual(tree[1].name, 'design');
		assert.deepStrictEqual(tree[1].children.map(child => child.name), ['card', 'modal']);
	});

	test('creates design-prefixed names by default', () => {
		assert.strictEqual(getDesignerBranchName('landing page', true), 'design/landing-page');
		assert.strictEqual(getDesignerBranchName('landing page', false), 'landing-page');
	});
});
