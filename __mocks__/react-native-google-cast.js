const MediaStreamType = {
	BUFFERED: 'BUFFERED',
	LIVE: 'LIVE',
	OTHER: 'OTHER'
};

const MediaRepeatMode = {
	OFF: 'REPEAT_OFF',
	ALL: 'REPEAT_ALL',
	ALL_AND_SHUFFLE: 'REPEAT_ALL_AND_SHUFFLE',
	SINGLE: 'REPEAT_SINGLE'
};

const MediaPlayerState = {
	IDLE: 'IDLE',
	PLAYING: 'PLAYING',
	PAUSED: 'PAUSED',
	BUFFERING: 'BUFFERING',
	LOADING: 'LOADING'
};

const MediaPlayerIdleReason = {
	CANCELLED: 'CANCELLED',
	ERROR: 'ERROR',
	FINISHED: 'FINISHED',
	INTERRUPTED: 'INTERRUPTED'
};

const MediaHlsSegmentFormat = {
	FMP4: 'fmp4'
};

const MediaHlsVideoSegmentFormat = {
	FMP4: 'fmp4'
};

class RemoteMediaClient {
	loadMedia = jest.fn(() => Promise.resolve());
	getMediaStatus = jest.fn(() => Promise.resolve(null));
	setStreamVolume = jest.fn(() => Promise.resolve());
	setStreamMuted = jest.fn(() => Promise.resolve());
	setActiveTrackIds = jest.fn(() => Promise.resolve());
	setTextTrackStyle = jest.fn(() => Promise.resolve());
	onMediaStatusUpdated = jest.fn(() => ({ remove: jest.fn() }));
	seek = jest.fn(() => Promise.resolve());
	stop = jest.fn(() => Promise.resolve());
	play = jest.fn(() => Promise.resolve());
	pause = jest.fn(() => Promise.resolve());
}

class CastChannel {
	constructor() {
		this.onMessage = jest.fn();
	}

	sendMessage = jest.fn(() => Promise.resolve());
	remove = jest.fn(() => Promise.resolve());
}

const MockSessionManager = {
	onSessionStarted: jest.fn(),
	onSessionResumed: jest.fn(),
	onSessionStartFailed: jest.fn(),
	onSessionEnded: jest.fn(),
	getCurrentCastSession: jest.fn(() => Promise.resolve(null)),
	endCurrentSession: jest.fn(() => Promise.resolve())
};

const CastContext = {
	getSessionManager: jest.fn(() => MockSessionManager),
	getCastState: jest.fn(() => Promise.resolve('no_devices_available')),
	showCastDialog: jest.fn(() => Promise.resolve(true)),
	onCastStateChanged: jest.fn()
};

const useRemoteMediaClient = jest.fn(() => null);

const CastButton = () => null;

module.exports = {
	CastButton,
	CastChannel,
	CastContext,
	MediaHlsSegmentFormat,
	MediaHlsVideoSegmentFormat,
	MediaPlayerIdleReason,
	MediaPlayerState,
	MediaRepeatMode,
	MediaStreamType,
	RemoteMediaClient,
	useRemoteMediaClient
};
