/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ToggleSidebarVisibilityAction } from '../../../browser/actions/layoutActions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';

suite('LayoutActions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('primary sidebar toggle also toggles activity bar visibility', () => {
		const action = new ToggleSidebarVisibilityAction();

		const visibleCalls = runAction(action, true);
		assert.deepStrictEqual(visibleCalls, [
			{ hidden: true, part: Parts.SIDEBAR_PART },
			{ hidden: true, part: Parts.ACTIVITYBAR_PART }
		]);

		const hiddenCalls = runAction(action, false);
		assert.deepStrictEqual(hiddenCalls, [
			{ hidden: false, part: Parts.SIDEBAR_PART },
			{ hidden: false, part: Parts.ACTIVITYBAR_PART }
		]);
	});
});

function runAction(action: ToggleSidebarVisibilityAction, sidebarVisible: boolean): { hidden: boolean; part: Parts }[] {
	const calls: { hidden: boolean; part: Parts }[] = [];
	const accessor = {
		get(service: unknown) {
			assert.strictEqual(service, IWorkbenchLayoutService);
			return {
				isVisible(part: Parts) {
					assert.strictEqual(part, Parts.SIDEBAR_PART);
					return sidebarVisible;
				},
				setPartHidden(hidden: boolean, part: Parts) {
					calls.push({ hidden, part });
				}
			};
		}
	} as ServicesAccessor;

	action.run(accessor);
	return calls;
}
