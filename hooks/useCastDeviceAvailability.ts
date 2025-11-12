/**
 * Copyright (c) 2025 Jellyfin Contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, type RefObject } from 'react';
import { useCastState, CastState } from 'react-native-google-cast';
import type { WebView } from 'react-native-webview';

/**
 * Hook to monitor Cast device availability and inject status into WebView
 * @param webview - React ref to the WebView component
 */
export const useCastDeviceAvailability = (webview: RefObject<WebView>) => {
	const castState = useCastState();

	useEffect(() => {
		const available = castState !== null && castState !== CastState.NO_DEVICES_AVAILABLE;
		webview.current?.injectJavaScript(
			`window.NativeShell && window.NativeShell.setCastDeviceAvailable && window.NativeShell.setCastDeviceAvailable(${available});`
		);
	}, [ castState, webview ]);
};
