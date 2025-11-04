import CastContext, {
	CastChannel,
	MediaPlayerState,
	RemoteMediaClient,
	type Device,
	type MediaLoadRequest,
	type MediaSeekOptions,
	type MediaStatus
} from 'react-native-google-cast';

import {
	asRecord,
	buildMediaInfo,
	isRecord,
	mapIdleReason,
	mapPlayerState,
	mapRepeatMode,
	mediaInfoToJson,
	queueDataFromStatus,
	queueItemToJson,
	queueLoadRequestFromChrome
} from './CastMessageSerializer';

const NOT_IMPLEMENTED_ERROR = 'not_implemented';
const SESSION_ERROR = 'session_error';
const CHANNEL_ERROR = 'channel_error';
const INVALID_PARAMETER = 'invalid_parameter';
const CANCEL_ERROR = 'cancel';

export type CastCallbackSender = (
	action: string,
	keep: boolean,
	err: unknown,
	result: unknown
) => void;

const MEDIA_SESSION_ID = 1;
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Bridge between the chrome.cast Cordova shim loaded inside the WebView and
 * react-native-google-cast running in the native shell. The goal is to expose
 * the subset of Chromecast behaviour Jellyfin Web expects while re-using the
 * modern Cast SDK bindings.
 */
class CastBridge {
	private static sendCallback: CastCallbackSender | null = null;
	private static initialized = false;
	private static chromeCastApiInitialized = false;
	private static pendingSessionSync = false;
	private static lastReceiverAvailability: boolean | null = null;
	private static castSession: import('react-native-google-cast').CastSession | null = null;
	private static remoteClient: RemoteMediaClient | null = null;
	private static mediaStatusSubscription?: { remove: () => void };
	private static pendingNamespaces = new Set<string>();
	private static channels = new Map<string, CastChannel>();
	private static requestSessionPending = false;
	private static requestSessionTimer?: ReturnType<typeof setTimeout>;
	private static lastKnownSessionJson: Record<string, unknown> | null = null;

	static init(sender: CastCallbackSender) {
		CastBridge.sendCallback = sender;
		CastBridge.ensureListeners();
	}

	static async handleExecCast(action?: string, args: unknown[] = []) {
		if (!action) {
			return;
		}

		console.debug('[CastBridge] execCast', action, args);

		try {
			switch (action) {
				case 'setup':
					CastBridge.handleSetup();
					break;
			case 'initialize':
				CastBridge.handleInitialize(args);
				break;
				case 'requestSession':
					await CastBridge.handleRequestSession();
					break;
				case 'sessionLeave':
					await CastBridge.handleEndSession(false);
					break;
				case 'sessionStop':
					await CastBridge.handleEndSession(true);
					break;
				case 'setReceiverVolumeLevel':
					await CastBridge.handleSetReceiverVolume(args[0]);
					break;
				case 'setReceiverMuted':
					await CastBridge.handleSetReceiverMuted(args[0]);
					break;
				case 'sendMessage':
					await CastBridge.handleSendMessage(args[0], args[1]);
					break;
				case 'addMessageListener':
					await CastBridge.handleAddMessageListener(args[0]);
					break;
				case 'loadMedia':
					await CastBridge.handleLoadMedia(args);
					break;
				case 'queueLoad':
					await CastBridge.handleQueueLoad(args);
					break;
				case 'queueJumpToItem':
					await CastBridge.handleQueueJumpToItem(args);
					break;
				case 'mediaPlay':
					await CastBridge.invokeOnClient('play', action);
					break;
				case 'mediaPause':
					await CastBridge.invokeOnClient('pause', action);
					break;
				case 'mediaSeek':
					await CastBridge.handleMediaSeek(args as unknown[]);
					break;
				case 'mediaStop':
					await CastBridge.invokeOnClient('stop', action);
					break;
				case 'setMediaVolume':
					await CastBridge.handleSetMediaVolume(args as unknown[]);
					break;
				case 'mediaEditTracksInfo':
					await CastBridge.handleEditTracksInfo(args as unknown[]);
					break;
				default:
					CastBridge.respondWithError(action, NOT_IMPLEMENTED_ERROR);
			}
		} catch (err) {
			console.error('[CastBridge] execCast failed', action, err);
			CastBridge.respondWithError(action, SESSION_ERROR);
		}
	}

	// -- Setup / events -----------------------------------------------------

	private static handleSetup() {
		console.log('[CastBridge] Setup called');
		CastBridge.emitEvent('SETUP', []);
		CastContext.getCastState()
			.then(state => {
				console.log('[CastBridge] Cast state:', state);
				CastBridge.emitEvent('RECEIVER_LISTENER', [CastBridge.isCastStateAvailable(state)]);
				return state;
			})
			.catch(() => {
				CastBridge.emitEvent('RECEIVER_LISTENER', [false]);
			});
		
		// Check for existing session
		CastContext.getSessionManager()
			.getCurrentCastSession()
			.then(session => {
				if (session) {
					console.log('[CastBridge] Found existing Cast session on setup');
					CastBridge.onSessionConnected(session);
				} else {
					console.log('[CastBridge] No existing Cast session');
				}
			})
			.catch(err => console.warn('[CastBridge] Failed to check for existing session:', err));
		
		CastBridge.sendCallback?.('setup', true, null, 'OK');
	}

	private static handleInitialize(_args: unknown[]) {
		CastBridge.chromeCastApiInitialized = true;
		CastBridge.flushPendingSessionSync();
		CastBridge.respondSuccess('initialize');
	}

	private static async handleRequestSession() {
		if (CastBridge.castSession) {
			const sessionJson = await CastBridge.sessionToJson(CastBridge.castSession);
			CastBridge.lastKnownSessionJson = sessionJson;
			CastBridge.emitEvent('SESSION_LISTENER', [ sessionJson ]);
			CastBridge.emitEvent('SESSION_UPDATE', [ sessionJson ]);
			CastBridge.emitMediaState(sessionJson);
			CastBridge.respondSuccess('requestSession', sessionJson);

			// Still show the Cast dialog so the user can switch devices if desired.
			try {
				const shown = await CastContext.showCastDialog();
				console.debug('[CastBridge] showCastDialog (existing session) result', shown);
				if (!shown) {
					console.debug('[CastBridge] showCastDialog returned false, showing expanded controls instead');
					await CastContext.showExpandedControls().catch(err => {
						console.warn('[CastBridge] showExpandedControls failed', err);
					});
				}
			} catch (err) {
				console.warn('[CastBridge] showCastDialog failed while already connected', err);
			}
			return;
		}

		CastBridge.requestSessionPending = true;
		CastBridge.requestSessionTimer && clearTimeout(CastBridge.requestSessionTimer);
		CastBridge.requestSessionTimer = setTimeout(() => {
			if (CastBridge.requestSessionPending) {
				CastBridge.requestSessionPending = false;
				CastBridge.respondWithError('requestSession', CANCEL_ERROR);
			}
		}, REQUEST_TIMEOUT_MS);

		const shown = await CastContext.showCastDialog();
		console.debug('[CastBridge] showCastDialog result', shown, 'hasSession', !!CastBridge.castSession);
		if (!shown && !CastBridge.castSession) {
			CastBridge.clearPendingRequest(CANCEL_ERROR);
		}
	}

	private static async handleEndSession(stopCasting: boolean) {
		const sessionManager = CastContext.getSessionManager();
		await sessionManager.endCurrentSession(stopCasting).catch(() => {
			throw new Error(SESSION_ERROR);
		});
		CastBridge.respondSuccess(stopCasting ? 'sessionStop' : 'sessionLeave');
	}

	// -- Receiver volume ----------------------------------------------------

	private static async handleSetReceiverVolume(level: unknown) {
		if (typeof level !== 'number') {
			CastBridge.respondWithError('setReceiverVolumeLevel', INVALID_PARAMETER);
			return;
		}

		if (!CastBridge.castSession) {
			CastBridge.respondWithError('setReceiverVolumeLevel', SESSION_ERROR);
			return;
		}

		try {
			CastBridge.castSession.setVolume(level);
			await CastBridge.emitSessionUpdate();
			CastBridge.respondSuccess('setReceiverVolumeLevel');
		} catch (err) {
			console.warn('[CastBridge] setVolume failed', err);
			CastBridge.respondWithError('setReceiverVolumeLevel', SESSION_ERROR);
		}
	}

	private static async handleSetReceiverMuted(muted: unknown) {
		if (typeof muted !== 'boolean') {
			CastBridge.respondWithError('setReceiverMuted', INVALID_PARAMETER);
			return;
		}

		if (!CastBridge.castSession) {
			CastBridge.respondWithError('setReceiverMuted', SESSION_ERROR);
			return;
		}

		try {
			CastBridge.castSession.setMute(muted);
			await CastBridge.emitSessionUpdate();
			CastBridge.respondSuccess('setReceiverMuted');
		} catch (err) {
			console.warn('[CastBridge] setMute failed', err);
			CastBridge.respondWithError('setReceiverMuted', SESSION_ERROR);
		}
	}

	// -- Messaging ----------------------------------------------------------

	private static async handleSendMessage(namespace: unknown, message: unknown) {
		if (typeof namespace !== 'string') {
			CastBridge.respondWithError('sendMessage', INVALID_PARAMETER);
			return;
		}

		const channel = await CastBridge.ensureChannel(namespace);
		if (!channel) {
			CastBridge.respondWithError('sendMessage', CHANNEL_ERROR);
			return;
		}

		try {
			await channel.sendMessage(message as Record<string, unknown> | string);
			CastBridge.respondSuccess('sendMessage');
		} catch (err) {
			console.warn('[CastBridge] sendMessage failed', err);
			CastBridge.respondWithError('sendMessage', CHANNEL_ERROR);
		}
	}

	private static async handleAddMessageListener(namespace: unknown) {
		if (typeof namespace !== 'string') {
			CastBridge.respondWithError('addMessageListener', INVALID_PARAMETER);
			return;
		}

		await CastBridge.ensureChannel(namespace);
		CastBridge.pendingNamespaces.add(namespace);
		CastBridge.respondSuccess('addMessageListener');
	}

	// -- Media control ------------------------------------------------------

	private static async handleLoadMedia(args: unknown[]) {
		console.log('[CastBridge] loadMedia', args);
		if (!CastBridge.remoteClient) {
			CastBridge.respondWithError('loadMedia', SESSION_ERROR);
			return;
		}

		const [
			contentId,
			customData,
			contentType,
			duration,
			streamType,
			autoplay,
			startTime,
			metadata,
			textTrackStyle
		] = args as [
			string,
			Record<string, unknown>,
			string,
			number,
			string,
			boolean,
			number,
			Record<string, unknown>,
			Record<string, unknown>
		];

		const mediaInfo = buildMediaInfo({
			contentId,
			customData,
			contentType,
			duration,
			streamType,
			metadata,
			textTrackStyle
		});

		const loadRequest: MediaLoadRequest = {
			autoplay,
			startTime,
			mediaInfo
		};

		await CastBridge.remoteClient.loadMedia(loadRequest);
		const status = await CastBridge.remoteClient.getMediaStatus();
		const mediaObject = CastBridge.castSession && status
			? await CastBridge.mediaStatusToJson(CastBridge.castSession, status)
			: null;

		if (mediaObject) {
			CastBridge.emitEvent('MEDIA_LOAD', [ mediaObject ]);
		}

		CastBridge.respondSuccess('loadMedia', mediaObject);
	}

	private static async handleQueueLoad(args: unknown[]) {
		if (!CastBridge.remoteClient) {
			CastBridge.respondWithError('queueLoad', SESSION_ERROR);
			return;
		}

		const [ requestRaw ] = args as [Record<string, unknown> | undefined];
		if (!isRecord(requestRaw)) {
			CastBridge.respondWithError('queueLoad', INVALID_PARAMETER);
			return;
		}

		try {
			const request = queueLoadRequestFromChrome(requestRaw);
			await CastBridge.remoteClient.loadMedia(request);
			const status = await CastBridge.remoteClient.getMediaStatus();
			const mediaObject = CastBridge.castSession && status
				? await CastBridge.mediaStatusToJson(CastBridge.castSession, status)
				: null;

			if (mediaObject) {
				CastBridge.emitEvent('MEDIA_LOAD', [ mediaObject ]);
			}

			CastBridge.respondSuccess('queueLoad', mediaObject);
		} catch (err) {
			console.warn('[CastBridge] queueLoad failed', err);
			CastBridge.respondWithError('queueLoad', SESSION_ERROR);
		}
	}

	private static async handleQueueJumpToItem(args: unknown[]) {
		const [ itemIdRaw ] = args as [number | undefined];
		const itemId = typeof itemIdRaw === 'number' ? itemIdRaw : Number(itemIdRaw);
		if (!Number.isFinite(itemId)) {
			CastBridge.respondWithError('queueJumpToItem', INVALID_PARAMETER);
			return;
		}

		console.warn('[CastBridge] queueJumpToItem not supported on this platform (requested id:', itemId, ')');
		CastBridge.respondWithError('queueJumpToItem', NOT_IMPLEMENTED_ERROR);
	}

	private static async handleMediaSeek(args: unknown[]) {
		if (!CastBridge.remoteClient) {
			CastBridge.respondWithError('mediaSeek', SESSION_ERROR);
			return;
		}

		const [position, resumeStateRaw] = args as [number, string | undefined];
		const options: MediaSeekOptions = {
			position,
			resumeState: CastBridge.mapResumeState(resumeStateRaw)
		};

		await CastBridge.remoteClient.seek(options);
		CastBridge.respondSuccess('mediaSeek');
	}

	private static async handleSetMediaVolume(args: unknown[]) {
		if (!CastBridge.remoteClient) {
			CastBridge.respondWithError('setMediaVolume', SESSION_ERROR);
			return;
		}

		const [level, muted] = args as [number | undefined, boolean | undefined];

		try {
			if (typeof level === 'number') {
				await CastBridge.remoteClient.setStreamVolume(level);
			}
			if (typeof muted === 'boolean') {
				await CastBridge.remoteClient.setStreamMuted(muted);
			}
			CastBridge.respondSuccess('setMediaVolume');
		} catch (err) {
			console.warn('[CastBridge] setMediaVolume failed', err);
			CastBridge.respondWithError('setMediaVolume', SESSION_ERROR);
		}
	}

	private static async handleEditTracksInfo(args: unknown[]) {
		if (!CastBridge.remoteClient) {
			CastBridge.respondWithError('mediaEditTracksInfo', SESSION_ERROR);
			return;
		}

		const [trackIdsRaw, textStyle] = args as [number[] | null, Record<string, unknown> | null];

		try {
			if (Array.isArray(trackIdsRaw)) {
				await CastBridge.remoteClient.setActiveTrackIds(trackIdsRaw);
			}
			if (textStyle) {
				await CastBridge.remoteClient.setTextTrackStyle(textStyle);
			}
			CastBridge.respondSuccess('mediaEditTracksInfo');
		} catch (err) {
			console.warn('[CastBridge] mediaEditTracksInfo failed', err);
			CastBridge.respondWithError('mediaEditTracksInfo', SESSION_ERROR);
		}
	}

	private static async invokeOnClient(method: keyof RemoteMediaClient, action: string) {
		if (!CastBridge.remoteClient) {
			CastBridge.respondWithError(action, SESSION_ERROR);
			return;
		}

		const fn = CastBridge.remoteClient[method] as (() => Promise<void>);
		await fn.call(CastBridge.remoteClient);
		CastBridge.respondSuccess(action);
	}

	// -- Helpers ------------------------------------------------------------

	private static ensureListeners() {
		if (CastBridge.initialized) return;
		CastBridge.initialized = true;

		const sessionManager = CastContext.getSessionManager();

		sessionManager.onSessionStarted(session => {
			CastBridge.onSessionConnected(session);
		});

		sessionManager.onSessionResumed(session => {
			CastBridge.onSessionConnected(session);
		});

		sessionManager.onSessionStartFailed((_session, error) => {
			console.warn('[CastBridge] session start failed', error);
			CastBridge.clearPendingRequest(SESSION_ERROR);
		});

		sessionManager.onSessionEnded((session, error) => {
			CastBridge.onSessionEnded(session, error);
		});

		CastContext.onCastStateChanged(state => {
			const available = CastBridge.isCastStateAvailable(state);
			CastBridge.lastReceiverAvailability = available;
			CastBridge.emitEvent('RECEIVER_LISTENER', [ available ]);
		});
	}

	private static async onSessionConnected(session: import('react-native-google-cast').CastSession) {
		console.log('[CastBridge] Cast session connected');
		CastBridge.castSession = session;
		CastBridge.remoteClient = session.getClient();
		CastBridge.attachRemoteClientListeners();
		await CastBridge.ensurePendingChannels();

		const sessionJson = await CastBridge.sessionToJson(session);
		CastBridge.lastKnownSessionJson = sessionJson;
		console.log('[CastBridge] Notifying web client of Cast session:', sessionJson.sessionId);
		CastBridge.emitEvent('SESSION_LISTENER', [ sessionJson ]);
		CastBridge.emitEvent('SESSION_UPDATE', [ sessionJson ]);
		CastBridge.emitMediaState(sessionJson);
		CastBridge.pendingSessionSync = false;
		CastBridge.clearPendingRequest(null, sessionJson);
	}

	private static onSessionEnded(
		session: import('react-native-google-cast').CastSession,
		error?: string
	) {
		void session;
		CastBridge.detachRemoteClientListeners();
		CastBridge.castSession = null;
		CastBridge.remoteClient = null;
		CastBridge.channels.forEach(channel => channel.remove().catch(() => undefined));
		CastBridge.channels.clear();

		if (CastBridge.lastKnownSessionJson) {
			const sessionJson = {
				...CastBridge.lastKnownSessionJson,
				status: 'stopped'
			};
			CastBridge.emitEvent('SESSION_UPDATE', [ sessionJson ]);
		}
		CastBridge.lastKnownSessionJson = null;

		if (CastBridge.requestSessionPending) {
			CastBridge.clearPendingRequest(error ?? CANCEL_ERROR);
		}
	}

	private static attachRemoteClientListeners() {
		if (!CastBridge.remoteClient || !CastBridge.castSession) return;

		CastBridge.detachRemoteClientListeners();
		CastBridge.mediaStatusSubscription = CastBridge.remoteClient.onMediaStatusUpdated(async status => {
			if (!status || !CastBridge.castSession) return;
			const mediaJson = await CastBridge.mediaStatusToJson(CastBridge.castSession, status);
			if (mediaJson) {
				CastBridge.emitEvent('MEDIA_UPDATE', [ mediaJson ]);
			}
		});
	}

	private static detachRemoteClientListeners() {
		CastBridge.mediaStatusSubscription?.remove();
		CastBridge.mediaStatusSubscription = undefined;
	}

	private static async ensurePendingChannels() {
		if (!CastBridge.castSession) return;

		for (const namespace of CastBridge.pendingNamespaces) {
			await CastBridge.ensureChannel(namespace);
		}
	}

	private static async ensureChannel(namespace: string): Promise<CastChannel | null> {
		if (CastBridge.channels.has(namespace)) {
			return CastBridge.channels.get(namespace) ?? null;
		}

		if (!CastBridge.castSession) {
			return null;
		}

		try {
			const channel = await CastBridge.castSession.addChannel(namespace);
			channel.onMessage(message => {
				CastBridge.emitEvent('RECEIVER_MESSAGE', [ namespace, message ]);
			});
			CastBridge.channels.set(namespace, channel);
			return channel;
		} catch (err) {
			console.warn('[CastBridge] ensureChannel failed', namespace, err);
			return null;
		}
	}

	private static clearPendingRequest(error: string | null, sessionJson?: Record<string, unknown>) {
		if (!CastBridge.requestSessionPending) return;
		CastBridge.requestSessionPending = false;
		CastBridge.requestSessionTimer && clearTimeout(CastBridge.requestSessionTimer);
		CastBridge.requestSessionTimer = undefined;

		if (sessionJson) {
			CastBridge.respondSuccess('requestSession', sessionJson);
		} else {
			CastBridge.respondWithError('requestSession', error ?? CANCEL_ERROR);
		}
	}

	private static async emitSessionUpdate() {
		if (!CastBridge.castSession) return;
		const sessionJson = await CastBridge.sessionToJson(CastBridge.castSession);
		CastBridge.lastKnownSessionJson = sessionJson;
		CastBridge.emitEvent('SESSION_UPDATE', [ sessionJson ]);
	}

	private static emitEvent(event: string, args: unknown[]) {
		CastBridge.sendCallback?.('setup', true, null, [ event, args ]);
	}

	private static respondSuccess(action: string, result: unknown = null) {
		CastBridge.sendCallback?.(action, false, null, result);
	}

	private static respondWithError(action: string, error: unknown) {
		CastBridge.sendCallback?.(action, false, error, null);
	}

	private static mapResumeState(state?: string): MediaSeekOptions['resumeState'] {
		switch (state) {
			case 'PLAYBACK_START':
				return 'play';
			case 'PLAYBACK_PAUSE':
				return 'pause';
			default:
				return undefined;
		}
	}

	private static async sessionToJson(session: import('react-native-google-cast').CastSession) {
		const [metadata, device, volumeLevel, isMuted, mediaStatus] = await Promise.all([
			session.getApplicationMetadata().catch(() => null as unknown),
			session.getCastDevice().catch(() => null as Device | null),
			session.getVolume().catch(() => null as number | null),
			session.isMute().catch(() => null as boolean | null),
			CastBridge.remoteClient?.getMediaStatus() ?? null
		]);
		const metadataRecord = asRecord(metadata);
		const metadataImages: Array<{ url: string }> = Array.isArray(metadataRecord?.images)
			? (metadataRecord.images as Array<{ url?: string }>)
				.filter((img): img is { url: string } => typeof img?.url === 'string')
				.map(img => ({ url: img.url }))
			: [];
		const metadataName = typeof metadataRecord?.name === 'string' ? metadataRecord.name : undefined;
		const metadataAppId = typeof metadataRecord?.applicationId === 'string' ? metadataRecord.applicationId : undefined;

		const receiver = device
			? {
				friendlyName: device.friendlyName,
				label: device.deviceId,
				volume: {
					level: volumeLevel ?? 1,
					muted: isMuted ?? false
				}
			}
			: (
				(asRecord(CastBridge.lastKnownSessionJson)?.receiver as Record<string, unknown> | undefined) ?? {
					friendlyName: metadataName ?? 'Chromecast',
					label: session.id,
					volume: {
						level: volumeLevel ?? 1,
						muted: isMuted ?? false
					}
				}
			);

		const mediaObjects = [] as Record<string, unknown>[];
		if (mediaStatus) {
			const mediaJson = await CastBridge.mediaStatusToJson(session, mediaStatus);
			if (mediaJson) {
				mediaObjects.push(mediaJson);
			}
		}

		return {
			appId: metadataAppId,
			appImages: metadataImages,
			displayName: metadataName,
			media: mediaObjects,
			receiver,
			sessionId: session.id
		};
	}

	private static async mediaStatusToJson(
		session: import('react-native-google-cast').CastSession,
		status: MediaStatus
	) {
		const mediaInfo = status.mediaInfo ? mediaInfoToJson(status.mediaInfo) : null;
		const queueItems = status.queueItems?.map((item, index) => queueItemToJson(item, index)) ?? [];

		return {
			activeTrackIds: status.activeTrackIds ?? undefined,
			currentItemId: status.currentItemId ?? null,
			currentTime: status.streamPosition ?? 0,
			customData: status.customData ?? undefined,
			idleReason: mapIdleReason(status.idleReason),
			items: queueItems,
			isAlive: status.playerState !== MediaPlayerState.IDLE,
			loadingItemId: status.loadingItemId ?? null,
			media: mediaInfo,
			mediaSessionId: MEDIA_SESSION_ID,
			playbackRate: status.playbackRate ?? 1,
			playerState: mapPlayerState(status.playerState),
			preloadedItemId: status.preloadedItemId ?? null,
			queueData: queueDataFromStatus(status),
			repeatMode: mapRepeatMode(status.queueRepeatMode),
			sessionId: session.id,
			volume: {
				level: status.volume ?? 1,
				muted: status.isMuted ?? false
			}
		};
	}

	static syncSessionWithWebView() {
		console.debug('[CastBridge] syncSessionWithWebView invoked');
		CastBridge.pendingSessionSync = true;
		CastBridge.flushPendingSessionSync();
	}

static syncReceiverAvailabilityWithWebView() {
	if (typeof CastBridge.lastReceiverAvailability === 'boolean') {
		console.debug('[CastBridge] replaying receiver availability', CastBridge.lastReceiverAvailability);
		CastBridge.emitEvent('RECEIVER_LISTENER', [ CastBridge.lastReceiverAvailability ]);
	}
}

private static emitMediaState(sessionJson: Record<string, unknown> | null) {
	const record = asRecord(sessionJson);
	const media = Array.isArray(record?.media) ? record.media : null;
	if (media && media.length > 0 && media[0]) {
		CastBridge.emitEvent('MEDIA_LOAD', [ media[0] ]);
		CastBridge.emitEvent('MEDIA_UPDATE', [ media[0] ]);
	}
}

private static flushPendingSessionSync() {
		if (!CastBridge.pendingSessionSync) return;
		if (!CastBridge.chromeCastApiInitialized) {
			console.debug('[CastBridge] delaying session sync until Cast API initializes');
			return;
		}
		if (!CastBridge.lastKnownSessionJson) {
			console.debug('[CastBridge] no cached Cast session to sync');
			return;
		}
		CastBridge.pendingSessionSync = false;
		console.debug('[CastBridge] replaying Cast session to web client');
		CastBridge.emitEvent('SESSION_LISTENER', [ CastBridge.lastKnownSessionJson ]);
		CastBridge.emitEvent('SESSION_UPDATE', [ CastBridge.lastKnownSessionJson ]);
		CastBridge.emitMediaState(CastBridge.lastKnownSessionJson);
	}

	private static isCastStateAvailable(state: string | null) {
		// Receiver is available when Cast SDK is initialized and devices exist
		// Exclude NO_DEVICES_AVAILABLE state
		return state !== null && state !== 'no_devices_available';
	}

	static hasActiveSession() {
		return !!CastBridge.castSession;
	}
}

export default CastBridge;
