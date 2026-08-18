/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { LlamaDownloadProgress, LlamaManagerStatus } from './llamaManagerTypes.js';

export interface ILlamaManagerService {
	readonly _serviceBrand: undefined;
	readonly onDownloadProgress: Event<LlamaDownloadProgress>;
	status(): Promise<LlamaManagerStatus>;
	start(): Promise<{ ok: true } | { ok: false, error: string }>;
	downloadModel(url?: string): Promise<{ ok: true, modelPath: string } | { ok: false, error: string }>;
	abortDownload(): void;
}

export const ILlamaManagerService = createDecorator<ILlamaManagerService>('LlamaManagerService');

class LlamaManagerService extends Disposable implements ILlamaManagerService {
	readonly _serviceBrand: undefined;
	private readonly channel: IChannel

	private readonly _onDownloadProgress = this._register(new Emitter<LlamaDownloadProgress>())
	readonly onDownloadProgress = this._onDownloadProgress.event

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super()
		this.channel = mainProcessService.getChannel('void-channel-llama-manager')
		this._register((this.channel.listen('onProgress_llamaManager') as Event<LlamaDownloadProgress>)(e => this._onDownloadProgress.fire(e)))
	}

	status(): Promise<LlamaManagerStatus> { return this.channel.call('status') }
	start(): Promise<{ ok: true } | { ok: false, error: string }> { return this.channel.call('start') }
	downloadModel(url?: string): Promise<{ ok: true, modelPath: string } | { ok: false, error: string }> { return this.channel.call('downloadModel', { url }) }
	abortDownload(): void { this.channel.call('abortDownload') }
}

registerSingleton(ILlamaManagerService, LlamaManagerService, InstantiationType.Delayed);
