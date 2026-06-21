/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DesignerBranchItem, DesignerBranchRef, DesignerBranchStatus, DesignerBranchTreeNode } from './designerBranchTypes';

interface BranchRefPair {
	local?: DesignerBranchRef;
	remote?: DesignerBranchRef;
}

interface MutableDesignerBranchTreeNode {
	name: string;
	path: string[];
	branch?: DesignerBranchItem;
	children: MutableDesignerBranchTreeNode[];
}

export function mergeDesignerBranchRefs(
	refs: readonly DesignerBranchRef[],
	defaultRemote: string | undefined,
	defaultBranch: string | undefined,
	currentBranch: string | undefined
): DesignerBranchItem[] {
	const refsByName = new Map<string, BranchRefPair>();

	for (const ref of refs) {
		const existing = refsByName.get(ref.name) ?? {};

		if (ref.type === 'local') {
			existing.local = ref;
		} else if (!existing.remote || ref.remote === defaultRemote) {
			existing.remote = ref;
		}

		refsByName.set(ref.name, existing);
	}

	return Array.from(refsByName.entries())
		.map(([name, refPair]) => createBranchItem(name, refPair, defaultBranch, currentBranch))
		.sort(compareBranchItems);
}

export function buildDesignerBranchTree(branches: readonly DesignerBranchItem[]): DesignerBranchTreeNode[] {
	const roots: MutableDesignerBranchTreeNode[] = [];

	for (const branch of branches) {
		let siblings = roots;
		let currentPath: string[] = [];

		for (const segment of branch.path) {
			currentPath = [...currentPath, segment];
			let node = siblings.find(candidate => candidate.name === segment);

			if (!node) {
				node = {
					name: segment,
					path: currentPath,
					children: []
				};
				siblings.push(node);
			}

			if (currentPath.length === branch.path.length) {
				node.branch = branch;
			}

			siblings = node.children;
		}
	}

	sortTree(roots);
	return roots;
}

export function getDesignerBranchName(input: string, useDesignPrefix: boolean): string {
	const sanitizedName = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9/_-]+/g, '-')
		.replace(/\/+/g, '/')
		.replace(/^-+|-+$/g, '')
		.replace(/^\/+|\/+$/g, '');

	if (!useDesignPrefix) {
		return sanitizedName;
	}

	return `design/${sanitizedName.replace(/^design\//, '')}`;
}

function createBranchItem(
	name: string,
	refPair: BranchRefPair,
	defaultBranch: string | undefined,
	currentBranch: string | undefined
): DesignerBranchItem {
	return {
		name,
		path: name.split('/').filter(Boolean),
		status: getBranchStatus(refPair),
		localName: refPair.local?.name,
		remoteName: refPair.remote?.name,
		remote: refPair.remote?.remote ?? refPair.local?.upstream?.remote,
		isCurrent: currentBranch === name,
		isDefault: defaultBranch === name
	};
}

function getBranchStatus(refPair: BranchRefPair): DesignerBranchStatus {
	if (refPair.local && refPair.remote) {
		return refPair.local.commit === refPair.remote.commit ? 'synced' : 'problem';
	}

	return refPair.local ? 'localOnly' : 'remoteOnly';
}

function compareBranchItems(first: DesignerBranchItem, second: DesignerBranchItem): number {
	if (first.isDefault !== second.isDefault) {
		return first.isDefault ? -1 : 1;
	}

	return first.name.localeCompare(second.name);
}

function sortTree(nodes: MutableDesignerBranchTreeNode[]): void {
	nodes.sort((first, second) => {
		if (first.branch?.isDefault !== second.branch?.isDefault) {
			return first.branch?.isDefault ? -1 : 1;
		}

		return first.name.localeCompare(second.name);
	});

	for (const node of nodes) {
		sortTree(node.children);
	}
}
