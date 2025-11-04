/**
 * Copyright (c) 2025 Jellyfin Contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';
import compareVersions from 'compare-versions';
import { nativeApplicationVersion } from 'expo-application';
import { activateKeepAwake, deactivateKeepAwake } from 'expo-keep-awake';
import React, { ForwardRefRenderFunction, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, BackHandler, Platform } from 'react-native';
import type { WebView, WebViewMessageEvent } from 'react-native-webview';

import CastBridge from '../bridges/CastBridge';
import { useStores } from '../hooks/useStores';
import DownloadModel from '../models/DownloadModel';
import { getAppName, getDeviceProfile, getSafeDeviceName } from '../utils/Device';
import StaticScriptLoader from '../utils/StaticScriptLoader';
import { openBrowser } from '../utils/WebBrowser';

	import RefreshWebView, { type RefreshWebViewProps } from './RefreshWebView';

type NativeShellWebViewProps = Omit<RefreshWebViewProps, 'isRefreshing' | 'onRefresh'>;

/**
 * A RefreshWebView with NativeShell script injection and message handling.
 */
const NativeShellWebView: ForwardRefRenderFunction<WebView, NativeShellWebViewProps> = (props, outerRef) => {
	const innerRef = useRef<WebView>(null);
	useImperativeHandle(outerRef, () => innerRef.current as WebView, []);

	const { rootStore, downloadStore, serverStore, mediaStore, settingStore } = useStores();
	const [ isRefreshing, setIsRefreshing ] = useState(false);
	const { t } = useTranslation();

	const server = serverStore.servers[settingStore.activeServer];
	const isPluginSupported = !!server.info?.Version && compareVersions.compare(server.info.Version, '10.7', '>=');

	const resolveStreamUrl = (payload: { url?: string, TranscodingUrl?: string, mediaSource?: { TranscodingUrl?: string } }) => {
		const rawTranscodingUrl = payload?.TranscodingUrl || payload?.mediaSource?.TranscodingUrl;
		if (rawTranscodingUrl && server?.urlString) {
			try {
				const url = new URL(rawTranscodingUrl, server.urlString);
				const subtitleMethod = url.searchParams.get('SubtitleMethod');
				if (subtitleMethod === 'Hls') {
					url.pathname = url.pathname.replace(/stream\.mp4$/i, 'master.m3u8');
					return url.toString();
				}
				return url.toString();
			} catch (error) {
				console.warn('[NativeShellWebView] Failed to resolve transcoding url', rawTranscodingUrl, error);
			}
		}

		return payload?.url ?? null;
	};

	const shouldUseNativeVideoPlayer = settingStore.isNativeVideoPlayerEnabled;
	const shouldUseNativeAudioPlayer = shouldUseNativeVideoPlayer && settingStore.isExperimentalNativeAudioPlayerEnabled;

	const nativeAudioScript = shouldUseNativeAudioPlayer ? StaticScriptLoader.scripts.NativeAudioPlayer : '';
	const nativeVideoScript = shouldUseNativeVideoPlayer ? StaticScriptLoader.scripts.NativeVideoPlayer : '';

	const injectedJavaScript = `
window.ExpoAppInfo = {
	appName: '${getAppName()}',
	appVersion: '${nativeApplicationVersion}',
	deviceId: '${rootStore.deviceId}',
	deviceName: '${getSafeDeviceName().replace(/'/g, '\\\'')}'
};

window.ExpoAppSettings = {
	isPluginSupported: ${isPluginSupported},
	isNativeVideoPlayerEnabled: ${shouldUseNativeVideoPlayer},
	isExperimentalNativeAudioPlayerEnabled: ${shouldUseNativeAudioPlayer}
};

window.ExpoVideoProfile = ${JSON.stringify(getDeviceProfile({ enableFmp4: settingStore.isFmp4Enabled }))};

function postExpoEvent(event, data) {
	window.ReactNativeWebView.postMessage(JSON.stringify({
		event: event,
		data: data
	}));
}

${nativeAudioScript}
${nativeVideoScript}

${StaticScriptLoader.scripts.NativeShell}

${StaticScriptLoader.scripts.CastEventEmitter}
${StaticScriptLoader.scripts.ChromeCast}

${StaticScriptLoader.scripts.WebPlayerCastShim || ''}

${StaticScriptLoader.scripts.ExpoRouterShim}

window.onerror = console.error;

true;
`;

	useEffect(() => {
		const sendCastCallback = (action: string, keep: boolean, err: unknown, result: unknown) => {
			const serializedAction = JSON.stringify(action);
			const serializedError = typeof err === 'undefined' || err === null ? 'null' : JSON.stringify(err);
			const serializedResult = typeof result === 'undefined' ? 'null' : JSON.stringify(result);
			innerRef.current?.injectJavaScript(
				`window.NativeShell && window.NativeShell.castCallback && window.NativeShell.castCallback(${serializedAction}, ${keep ? 'true' : 'false'}, ${serializedError}, ${serializedResult});`
			);
		};

		CastBridge.init(sendCastCallback);
	}, []);

	const lastPlayerConfigRef = useRef<{ video: boolean, audio: boolean }>({
		video: shouldUseNativeVideoPlayer,
		audio: shouldUseNativeAudioPlayer
	});

	useEffect(() => {
		const prev = lastPlayerConfigRef.current;
		if (prev.video === shouldUseNativeVideoPlayer && prev.audio === shouldUseNativeAudioPlayer) {
			return;
		}
		lastPlayerConfigRef.current = {
			video: shouldUseNativeVideoPlayer,
			audio: shouldUseNativeAudioPlayer
		};
		innerRef.current?.reload();
	}, [ shouldUseNativeAudioPlayer, shouldUseNativeVideoPlayer ]);

	const onRefresh = () => {
		// Disable pull to refresh when in fullscreen
		if (rootStore.isFullscreen) return;

		// Stop media playback in native players
		mediaStore.set({ shouldStop: true });

		setIsRefreshing(true);
		innerRef.current?.reload();
		setIsRefreshing(false);
	};

	const onMessage = ({ nativeEvent: state }: WebViewMessageEvent) => {
		try {
			const { event, data } = JSON.parse(state.data);
			switch (event) {
				case 'pluginError':
					console.error('[Browser Console][PluginError]', data?.message ?? data);
					break;
				case 'execCast':
					void CastBridge.handleExecCast(data?.action, data?.args);
					break;
				case 'AppHost.exit':
					BackHandler.exitApp();
					break;
				case 'enableFullscreen':
					rootStore.set({ isFullscreen: true });
					break;
				case 'disableFullscreen':
					rootStore.set({ isFullscreen: false });
					break;
				case 'downloadFile': {
					console.log('Download item', data);

					// Get the API key from the download URL
					let apiKey;
					try {
						const url = new URL(data.item.url);
						apiKey = url.searchParams.get('api_key');
					} catch (e) {
						console.error('[NativeShellWebView] downloadFile: failed to get api key from download url', data.item?.url);
						Alert.alert(
							t('alerts.downloadFailed.title'),
							t('alerts.downloadFailed.description')
						);
						break;
					}

					// Validate that required fields are present
					if (!apiKey || !data.item?.filename || !data.item?.item) {
						console.error('[NativeShellWebView] downloadFile: missing required fields', {
							hasApiKey: !!apiKey,
							hasFilename: !!data?.item?.filename,
							hasItem: !!data?.item?.item
						});
						Alert.alert(
							t('alerts.downloadFailed.title'),
							t('alerts.downloadFailed.description')
						);
						break;
					}

					downloadStore.add(new DownloadModel(
						data.item.item,
						server.urlString,
						apiKey,
						data.item.filename,
						data.item.url
					));
					break;
				}
				case 'openUrl':
					console.log('Opening browser for external url', data.url);
					openBrowser(data.url);
					break;
				case 'chromecast.loaded':
					console.debug('[NativeShellWebView] Chromecast plugin signaled ready, syncing session');
					CastBridge.syncSessionWithWebView();
					CastBridge.syncReceiverAvailabilityWithWebView();
					break;
				case 'updateMediaSession':
					// Keep the screen awake when music is playing
					if (settingStore.isScreenLockEnabled) {
						activateKeepAwake();
					}
					break;
				case 'hideMediaSession':
					// When music session stops disable keep awake
					if (settingStore.isScreenLockEnabled) {
						deactivateKeepAwake();
					}
					break;
				case 'requestCastSession':
					console.log('[NativeShellWebView] requestCastSession');
					void CastBridge.handleExecCast('requestSession', []);
					break;
				case 'ExpoAudioPlayer.play':
				case 'ExpoVideoPlayer.play':
					if (!shouldUseNativeVideoPlayer) break;
					console.debug('[NativeShellWebView] play payload', data);
					const streamUrl = resolveStreamUrl(data);
					const mediaSource = data.mediaSource ?? null;
					const item = data.item ?? null;
					const audioStreamIndex = typeof data?.mediaSource?.DefaultAudioStreamIndex === 'number'
						? data.mediaSource.DefaultAudioStreamIndex
						: (typeof data?.playOptions?.AudioStreamIndex === 'number'
							? data.playOptions.AudioStreamIndex
							: null);
					const subtitleStreamIndex = typeof data?.mediaSource?.DefaultSubtitleStreamIndex === 'number'
						? data.mediaSource.DefaultSubtitleStreamIndex
						: (typeof data?.playOptions?.SubtitleStreamIndex === 'number'
							? data.playOptions.SubtitleStreamIndex
							: null);
					mediaStore.set({
						type: event === 'ExpoAudioPlayer.play' ? MediaType.Audio : MediaType.Video,
						uri: streamUrl,
						backdropUri: data.backdropUrl,
						isFinished: false,
						positionTicks: data.playerStartPositionTicks,
						item,
						mediaSource,
						playSessionId: data.playSessionId ?? null,
						audioStreamIndex,
						subtitleStreamIndex
					});
					break;
				case 'ExpoAudioPlayer.playPause':
				case 'ExpoVideoPlayer.playPause':
					if (!shouldUseNativeVideoPlayer) break;
					mediaStore.set({ shouldPlayPause: true });
					break;
				case 'ExpoAudioPlayer.stop':
				case 'ExpoVideoPlayer.stop':
					if (!shouldUseNativeVideoPlayer) break;
					mediaStore.set({ shouldStop: true });
					break;
				case 'console.debug':
					console.debug('[Browser Console]', data);
					break;
				case 'console.error':
					console.error('[Browser Console]', data);
					break;
				case 'console.info':
					// console.info('[Browser Console]', data);
					break;
				case 'console.log':
					console.log('[Browser Console]', data);
					break;
				case 'console.warn':
					console.warn('[Browser Console]', data);
					break;
				default:
					console.debug('[HomeScreen.onMessage]', event, JSON.stringify(data));
			}
		} catch (ex) {
			console.warn('Exception handling message', state.data);
		}
	};

	return (
		<RefreshWebView
			ref={innerRef}
			// Pass through additional props
			{...props}
			// Allow any origin blocking can break various things like book playback
			originWhitelist={[ '*' ]}
			source={{ uri: server.urlString }}
			// Inject javascript for NativeShell
			// This method is preferred, but only supported on iOS currently
			injectedJavaScriptBeforeContentLoaded={Platform.OS === 'ios' ? injectedJavaScript : undefined}
			// Fallback for non-iOS
			injectedJavaScript={Platform.OS !== 'ios' ? injectedJavaScript : undefined}
			onMessage={onMessage}
			isRefreshing={isRefreshing}
			onRefresh={onRefresh}
			// Make scrolling feel faster
			decelerationRate='normal'
			// Media playback options to fix video player
			allowsInlineMediaPlayback={true}
			mediaPlaybackRequiresUserAction={false}
			showsVerticalScrollIndicator={false}
			showsHorizontalScrollIndicator={false}
		/>
	);
};

const ForwardRefNativeShellWebview = React.forwardRef(NativeShellWebView);
ForwardRefNativeShellWebview.displayName = 'NativeShellWebView';

export default ForwardRefNativeShellWebview;
