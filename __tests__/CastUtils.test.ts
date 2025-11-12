import { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';
import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client/models/media-source-info';

import {
	buildCastMetadata,
	parseStreamContext,
	resolveMediaUrl,
	sanitizeStreamUri,
	ticksToSeconds
} from '../utils/CastUtils';

describe('CastUtils', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('parses stream context from url', () => {
		const url = 'https://demo.jellyfin.org/videos/12345/master.m3u8?api_key=abc123&MediaSourceId=source1';
		const context = parseStreamContext(url);
		expect(context).not.toBeNull();
		expect(context?.baseUrl).toBe('https://demo.jellyfin.org');
		expect(context?.itemId).toBe('12345');
		expect(context?.mediaSourceId).toBe('source1');
	});

	it('returns null when api key missing', () => {
		const context = parseStreamContext('https://demo/videos/123/master.m3u8');
		expect(context).toBeNull();
	});

	it('resolves media url with enforced codecs and playSession id', () => {
		const context = {
			baseUrl: 'https://demo',
			apiKey: 'abc123',
			itemId: 'item1',
			mediaSourceId: 'source1'
		};
		const source = {
			TranscodingUrl: '/videos/item1/master.m3u8?StartTimeTicks=100',
			TranscodingSubProtocol: 'HLS'
		} as MediaSourceInfo;

		const url = resolveMediaUrl(source, context, 'session123', 'device-xyz');
		expect(url).not.toBeNull();
		const finalUrl = url as string;
		expect(finalUrl).toContain('api_key=abc123');
		expect(finalUrl).toContain('PlaySessionId=session123');
		expect(finalUrl).toContain('DeviceId=device-xyz');
		expect(finalUrl).not.toContain('StartTimeTicks');
		expect(finalUrl).toContain('VideoCodec=h264');
		expect(finalUrl).toContain('AudioCodec=aac');
		expect(finalUrl).toContain('MediaSourceId=source1');
		expect(new URL(finalUrl).pathname.endsWith('/master.m3u8')).toBe(true);
	});

	it('builds metadata for audio and video types', () => {
		const audioMeta = buildCastMetadata(MediaType.Audio, 'Song', 'https://demo/song.jpg');
		expect(audioMeta.type).toBe('musicTrack');
		expect(audioMeta.images?.[0].url).toBe('https://demo/song.jpg');

		const videoMeta = buildCastMetadata(MediaType.Video, null, null);
		expect(videoMeta.type).toBe('movie');
		expect(videoMeta.title).toBe('Jellyfin Media');
		expect(videoMeta.images).toBeUndefined();
	});

	it('sanitizes original uri start time params', () => {
		const sanitized = sanitizeStreamUri('https://demo/stream.mp4?StartTimeTicks=10&startTimeTicks=20&foo=bar');
		expect(sanitized).toBe('https://demo/stream.mp4?foo=bar');
	});

	it('converts ticks to seconds', () => {
		expect(ticksToSeconds(30_000_000)).toBe(3);
		expect(ticksToSeconds(null)).toBe(0);
	});
});
