/**
 * Copyright (c) 2025 Jellyfin Contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';
import { getMediaInfoApi } from '@jellyfin/sdk/lib/utils/api/media-info-api';
import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import { DlnaProfileType } from '@jellyfin/sdk/lib/generated-client/models/dlna-profile-type';
import { MediaStreamProtocol } from '@jellyfin/sdk/lib/generated-client/models/media-stream-protocol';
import { useEffect, useRef } from 'react';
import {
	MediaHlsSegmentFormat,
	MediaHlsVideoSegmentFormat,
	MediaStreamType,
	useRemoteMediaClient
} from 'react-native-google-cast';

import { useStores } from '../hooks/useStores';
import { getDeviceProfile } from '../utils/Device';
import {
	buildCastMetadata,
	parseStreamContext,
	resolveMediaUrl,
	sanitizeStreamUri,
	ticksToSeconds
} from '../utils/CastUtils';

/**
 * CastManager intercepts playback events and routes them to Cast if connected.
 */
const CastManager = () => {
	const { mediaStore, rootStore, settingStore } = useStores();
	const client = useRemoteMediaClient();
	const nativeCastPlayerRef = useRef<Record<string, unknown> | null>(null);

	const loadTokenRef = useRef<string | null>(null);
	const pendingSeekRef = useRef<number | null>(null);

	if (!settingStore.isNativeVideoPlayerEnabled) {
		return null;
	}

	const itemId = mediaStore.item?.Id ?? null;
	const streamUri = mediaStore.uri ?? null;

	useEffect(() => {
		nativeCastPlayerRef.current = typeof window.NativeShell?.getCastPlayer === 'function'
			? window.NativeShell.getCastPlayer()
			: null;
	}, []);

	useEffect(() => {
		if (!client || !streamUri || !itemId) {
			return;
		}

			const loadToken = `${itemId}:${streamUri}`;
			if (loadTokenRef.current === loadToken) {
				return;
			}

		let cancelled = false;
		loadTokenRef.current = loadToken;

		const context = parseStreamContext(streamUri, itemId, mediaStore.mediaSource?.Id ?? null);
		if (!context) {
			return;
		}

		const resumePositionSeconds = ticksToSeconds(mediaStore.positionTicks);
		pendingSeekRef.current = resumePositionSeconds > 0 ? resumePositionSeconds : null;

		const load = async () => {
			try {
				const api = rootStore.getSdk().createApi(context.baseUrl, context.apiKey);
				const deviceProfile: DeviceProfile = JSON.parse(JSON.stringify(
					getDeviceProfile({ enableFmp4: settingStore.isFmp4Enabled })
				));

				deviceProfile.TranscodingProfiles = deviceProfile.TranscodingProfiles?.filter(profile => {
					if (profile.Type === DlnaProfileType.Video) {
						return profile.Protocol === MediaStreamProtocol.Hls;
					}
					return true;
				}) ?? [];

				const { data } = await getMediaInfoApi(api)
					.getPostedPlaybackInfo({
						itemId: context.itemId,
						playbackInfoDto: {
							DeviceProfile: deviceProfile,
							MediaSourceId: context.mediaSourceId ?? undefined,
							StartTimeTicks: mediaStore.positionTicks ?? undefined,
							AudioStreamIndex: mediaStore.audioStreamIndex ?? undefined,
							SubtitleStreamIndex: mediaStore.subtitleStreamIndex ?? undefined,
							EnableDirectPlay: true,
							EnableDirectStream: false,
							EnableTranscoding: true,
							AllowVideoStreamCopy: false,
							AllowAudioStreamCopy: false,
							AutoOpenLiveStream: true
						}
					});

				if (cancelled) return;

				const playSessionId = data.PlaySessionId ?? null;
				const source = data.MediaSources?.[0];
				if (!source) {
					console.warn('[CastManager] PlaybackInfo response did not include media sources');
					return;
				}

				const contentUrl = resolveMediaUrl(
					source,
					context,
					playSessionId,
					rootStore.deviceId
				);

				if (!contentUrl) {
					console.warn('[CastManager] Unable to resolve content url for cast');
					return;
				}

				mediaStore.set({
					playSessionId,
					mediaSource: source
				});

				const contentType = contentUrl.includes('.m3u8')
					? 'application/x-mpegURL'
					: mediaStore.type === MediaType.Audio
						? 'audio/mp4'
						: 'video/mp4';

				const metadata = buildCastMetadata(
					mediaStore.type,
					mediaStore.item?.Name,
					mediaStore.backdropUri
				);

				console.log('[CastManager] Loading media on Cast:', {
					contentUrl,
					contentType,
					playSessionId,
					streamType: 'BUFFERED'
				});

				await client.loadMedia({
					autoplay: true,
					mediaInfo: {
						contentUrl,
						contentId: contentUrl,
						contentType,
						streamType: MediaStreamType.BUFFERED,
						hlsSegmentFormat: MediaHlsSegmentFormat.FMP4,
						hlsVideoSegmentFormat: MediaHlsVideoSegmentFormat.FMP4,
						customData: {
							playSessionId
						},
						metadata
					}
				});
			} catch (err) {
				console.error('[CastManager] Failed to prepare cast media', err);
				if (cancelled) return;

				const fallbackUrl = sanitizeStreamUri(streamUri);
				if (fallbackUrl) {
					try {
						const fallbackContentType = fallbackUrl.includes('.m3u8')
							? 'application/x-mpegURL'
							: mediaStore.type === MediaType.Audio
								? 'audio/mp4'
								: 'video/mp4';

						const fallbackMetadata = buildCastMetadata(
							mediaStore.type,
							mediaStore.item?.Name,
							mediaStore.backdropUri
						);

						console.log('[CastManager] Loading fallback media on Cast:', {
							contentUrl: fallbackUrl,
							contentType: fallbackContentType,
							playSessionId: mediaStore.playSessionId,
							streamType: 'BUFFERED'
						});

						await client.loadMedia({
							autoplay: true,
							mediaInfo: {
								contentUrl: fallbackUrl,
								contentId: fallbackUrl,
								contentType: fallbackContentType,
								streamType: MediaStreamType.BUFFERED,
								hlsSegmentFormat: MediaHlsSegmentFormat.FMP4,
								hlsVideoSegmentFormat: MediaHlsVideoSegmentFormat.FMP4,
								customData: {
									playSessionId: mediaStore.playSessionId
								},
								metadata: fallbackMetadata
							}
						});
					} catch (fallbackErr) {
						console.error('[CastManager] Fallback cast load failed', fallbackErr);
					}
					}
				}
			};

		void load();

		return () => {
			cancelled = true;
		};
		}, [
			client,
			itemId,
			streamUri,
			mediaStore.audioStreamIndex,
			mediaStore.subtitleStreamIndex,
			mediaStore.positionTicks,
			rootStore.deviceId,
			settingStore.isFmp4Enabled
	]);

	// Resume playback once the receiver starts playing
	useEffect(() => {
		if (!client) return;

		const subscription = client.onMediaStatusUpdated(status => {
			if (!status) {
				return;
			}

			if (status.playerState === 'playing' && pendingSeekRef.current && pendingSeekRef.current > 0) {
				const seekTo = pendingSeekRef.current;
				pendingSeekRef.current = null;
				client.seek({
					position: seekTo,
					resumeState: 'play'
				})
					.catch(err => console.warn('[CastManager] Failed to seek after cast start', err));
			}

			console.log('[CastManager] Media status update:', {
				playerState: status.playerState,
				idleReason: status.idleReason,
				streamPosition: status.streamPosition,
				contentUrl: status.mediaInfo?.contentUrl
			});
		});

		return () => subscription.remove();
	}, [ client ]);

	// Handle play/pause on Cast
	useEffect(() => {
		if (!client || !mediaStore.shouldPlayPause) return;

		const togglePlayPause = async () => {
			try {
				const status = await client.getMediaStatus();
				if (status?.playerState === 'playing') {
					await client.pause();
				} else {
					await client.play();
				}
			} catch (err) {
				console.error('[CastManager] Failed to toggle play/pause:', err);
			} finally {
				mediaStore.set({ shouldPlayPause: false });
			}
		};

		togglePlayPause();
	}, [ client, mediaStore.shouldPlayPause ]);

	// Handle stop on Cast
	useEffect(() => {
		if (!client || !mediaStore.shouldStop) return;

		const stopCast = async () => {
			try {
				const status = await client.getMediaStatus().catch(() => null);
				if (!status) {
					return;
				}
				await client.stop();
			} catch (err) {
				console.warn('[CastManager] Unable to stop cast session:', err);
			} finally {
				mediaStore.set({ shouldStop: false });
			}
		};

		stopCast();
	}, [ client, mediaStore.shouldStop ]);

	return null;
};

export default CastManager;
