import { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';
import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client/models/media-source-info';

export { ticksToSeconds } from './Time';

export type StreamContext = {
	baseUrl: string,
	apiKey: string,
	itemId: string,
	mediaSourceId?: string | null
};

export const parseStreamContext = (
	uri: string,
	fallbackItemId?: string | null,
	fallbackMediaSourceId?: string | null
): StreamContext | null => {
	try {
		const url = new URL(uri);
		const apiKey = url.searchParams.get('api_key')
			|| url.searchParams.get('ApiKey');
		if (!apiKey) {
			return null;
		}

		const segments = url.pathname.split('/').filter(Boolean);
		const videosIndex = segments.findIndex(segment => {
			const lower = segment.toLowerCase();
			return lower === 'videos' || lower === 'audio';
		});
		const itemId = fallbackItemId ?? (videosIndex >= 0 ? segments[videosIndex + 1] : null);
		if (!itemId) {
			return null;
		}

		const mediaSourceId = fallbackMediaSourceId
			?? url.searchParams.get('MediaSourceId')
			?? url.searchParams.get('mediaSourceId')
			?? null;

		return {
			baseUrl: `${url.protocol}//${url.host}`,
			apiKey,
			itemId,
			mediaSourceId
		};
	} catch (err) {
		console.warn('[CastUtils] Failed to parse stream context', err);
		return null;
	}
};

export const resolveMediaUrl = (
	source: MediaSourceInfo,
	context: StreamContext,
	playSessionId: string | null,
	deviceId: string
) => {
	const rawUrl = source.TranscodingUrl ?? source.Path;
	if (!rawUrl) {
		return null;
	}

	const url = new URL(rawUrl, context.baseUrl);

	url.searchParams.delete('StartTimeTicks');
	url.searchParams.delete('startTimeTicks');

	if (!url.searchParams.has('api_key') && !url.searchParams.has('ApiKey')) {
		url.searchParams.set('api_key', context.apiKey);
	}

	if (!url.searchParams.has('DeviceId') && deviceId) {
		url.searchParams.set('DeviceId', deviceId);
	}

	if (playSessionId && !url.searchParams.has('PlaySessionId')) {
		url.searchParams.set('PlaySessionId', playSessionId);
	}

	if (context.mediaSourceId && !url.searchParams.has('MediaSourceId')) {
		url.searchParams.set('MediaSourceId', context.mediaSourceId);
	}

	url.searchParams.set('VideoCodec', 'h264');
	url.searchParams.set('RequireAvc', 'true');
	url.searchParams.set('AudioCodec', 'aac');
	url.searchParams.set('h264-profile', 'main');
	url.searchParams.set('h264-level', '40');
	url.searchParams.set('h264-rangetype', 'SDR');
	url.searchParams.set('h264-deinterlace', 'true');
	[
		'hevc-profile',
		'hevc-level',
		'hevc-deinterlace',
		'hevc-codectag',
		'hevc-rangetype',
		'hevc-videobitdepth',
		'h264-profile',
		'h264-level',
		'h264-rangetype',
		'h264-videobitdepth'
	].forEach(param => {
		const lowerParam = param.toLowerCase();
		Array.from(url.searchParams.keys())
			.filter(key => key.toLowerCase() === lowerParam)
			.forEach(key => url.searchParams.delete(key));
	});

	if (source.TranscodingSubProtocol?.toLowerCase() === 'hls' && url.pathname.endsWith('/stream.mp4')) {
		url.pathname = url.pathname.replace(/\/stream\.mp4$/i, '/master.m3u8');
	}

	return url.toString();
};

export const buildCastMetadata = (mediaType: MediaType | null, title?: string | null, imageUrl?: string | null) => ({
	type: mediaType === MediaType.Audio ? 'musicTrack' as const : 'movie' as const,
	title: title || 'Jellyfin Media',
	images: imageUrl ? [{ url: imageUrl }] : undefined
});

export const sanitizeStreamUri = (uri: string) => {
	try {
		const url = new URL(uri);
		url.searchParams.delete('StartTimeTicks');
		url.searchParams.delete('startTimeTicks');
		return url.toString();
	} catch {
		return uri;
	}
};
