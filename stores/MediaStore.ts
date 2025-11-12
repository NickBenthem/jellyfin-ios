/**
 * Copyright (c) 2025 Jellyfin Contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client/models/media-source-info';
import { create } from 'zustand';

import { ticksToMs } from '../utils/Time';

import { logger } from './middleware/logger';

type State = {
	/** The media type being played */
	type: MediaType | null,

	/** URI of the current media file */
	uri: string | null,

	/** URI of the backdrop image of the current media item */
	backdropUri: string | null,

	/** Current playback position (in ticks) */
	positionTicks: number,

	/** Has media playback finished */
	isFinished: boolean,

	/** Is the media in a local file (i.e. not streaming) */
	isLocalFile: boolean,

	/** Is the media currently playing */
	isPlaying: boolean,

	/** The player should toggle the play/pause state */
	shouldPlayPause: boolean,

	/** The player should stop playback */
	shouldStop: boolean,

	/** Source item metadata */
	item: Partial<BaseItemDto> | null,

	/** Original media source metadata */
	mediaSource: Partial<MediaSourceInfo> | null,

	/** Jellyfin play session id */
	playSessionId: string | null,

	/** Preferred audio stream index */
	audioStreamIndex: number | null,

	/** Preferred subtitle stream index */
	subtitleStreamIndex: number | null
}

type Actions = {
	set: (v: Partial<State>) => void,

	/** Current position in milliseconds */
	getPositionMillis: () => number,

	/** Resets the store to a default state */
	reset: () => void
}

export type MediaStore = State & Actions

const STORE_NAME = 'MediaStore';

const initialState: State = {
	type: null,
	uri: null,
	backdropUri: null,
	isFinished: false,
	isLocalFile: false,
	isPlaying: false,
	positionTicks: 0,
	shouldPlayPause: false,
	shouldStop: false,
	item: null,
	mediaSource: null,
	playSessionId: null,
	audioStreamIndex: null,
	subtitleStreamIndex: null
};

export const useMediaStore = create<State & Actions>()(
	logger(
		(_set, _get) => ({
			...initialState,
			set: state => _set(prev => ({
				...prev,
				...state
			})),
			getPositionMillis: () => ticksToMs(_get().positionTicks),
			reset: () => {
				_set({ ...initialState });
			}
		}),
		STORE_NAME
	)
);
