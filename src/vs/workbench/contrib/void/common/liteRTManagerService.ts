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
import { LiteRTProgress, LiteRTStatus } from './liteRTManagerTypes.js';

export interface ILiteRTManagerService {
	readonly _serviceBrand: undefined;
	readonly onProgress: Event<LiteRTProgress>;
	status(): Promise<LiteRTStatus>;
	setup(opts?: { repo?: string, file?: string, id?: string }): Promise<{ ok: true, modelIds: string[] } | { ok: false, error: string }>;
	start(): Promise<{ ok: true } | { ok: false, error: string }>;
	abortSetup(): void;
}

export const ILiteRTManagerService = createDecorator<ILiteRTManagerService>('LiteRTManagerService');

class LiteRTManagerService extends Disposable implements ILiteRTManagerService {
	readonly _serviceBrand: undefined;
	private readonly channel: IChannel

	private readonly _onProgress = this._register(new Emitter<LiteRTProgress>())
	readonly onProgress = this._onProgress.event

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super()
		this.channel = mainProcessService.getChannel('void-channel-litert')
		this._register((this.channel.listen('onProgress_liteRT') as Event<LiteRTProgress>)(e => this._onProgress.fire(e)))
	}

	status(): Promise<LiteRTStatus> { return this.channel.call('status') }
	setup(opts?: { repo?: string, file?: string, id?: string }): Promise<{ ok: true, modelIds: string[] } | { ok: false, error: string }> { return this.channel.call('setup', opts) }
	start(): Promise<{ ok: true } | { ok: false, error: string }> { return this.channel.call('start') }
	abortSetup(): void { this.channel.call('abortSetup') }
}

registerSingleton(ILiteRTManagerService, LiteRTManagerService, InstantiationType.Delayed);
