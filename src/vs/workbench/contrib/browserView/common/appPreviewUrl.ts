/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAllInterfacesAuthority, isLocalhostAuthority } from '../../../../platform/url/common/trustedDomains.js';

const URL_PATTERN = /https?:\/\/(?:\[[^\]\s]+\]|[^\s/:]+)(?::\d+)?(?:\/[^\s]*)?/gi;

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

export function normalizeHttpUrl(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return undefined;
	}

	return url.href;
}

function normalizeLocalhostUrl(value: string): string | undefined {
	const url = normalizeHttpUrl(value);
	if (!url) {
		return undefined;
	}

	const parsed = new URL(url);
	if (isAllInterfacesAuthority(parsed.host)) {
		parsed.hostname = 'localhost';
		return parsed.href;
	}

	if (!isLocalhostAuthority(parsed.host)) {
		return undefined;
	}

	return parsed.href;
}
