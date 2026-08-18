/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { localize2 } from '../../../../nls.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ILlamaManagerService } from '../common/llamaManagerService.js';
import { ORNITH_MODEL_SIZE_GB } from '../common/llamaManagerTypes.js';

// One-shot setup for the bundled local model: download the .gguf if missing (resumable),
// then start llama-server. The llamaServer provider autodetects the model within seconds.
registerAction2(class extends Action2 {
	constructor() {
		super({
			f1: true,
			id: 'void.setupLocalOrnith',
			title: localize2('voidSetupOrnith', 'Void: Set Up Local Ornith Model'),
		});
	}
	async run(accessor: ServicesAccessor) {
		const llamaManager = accessor.get(ILlamaManagerService)
		const progressService = accessor.get(IProgressService)
		const notificationService = accessor.get(INotificationService)

		const status = await llamaManager.status()
		if (status.serverHealthy) {
			notificationService.info('Local model server is already running.')
			return
		}

		if (!status.modelPath) {
			const res = await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: `Downloading Ornith 9B (~${ORNITH_MODEL_SIZE_GB} GB)…`,
				cancellable: true,
			}, (progress) => {
				let lastPct = 0
				const sub = llamaManager.onDownloadProgress(({ received, total }) => {
					if (!total) return
					const pct = Math.floor(received / total * 100)
					if (pct > lastPct) {
						progress.report({ increment: pct - lastPct, message: `${(received / 1e9).toFixed(1)} / ${(total / 1e9).toFixed(1)} GB` })
						lastPct = pct
					}
				})
				return llamaManager.downloadModel().finally(() => sub.dispose())
			}, () => llamaManager.abortDownload())

			if (!res.ok) {
				notificationService.notify({ severity: Severity.Error, message: res.error })
				return
			}
		}

		const started = await progressService.withProgress(
			{ location: ProgressLocation.Notification, title: 'Starting local model server…' },
			() => llamaManager.start(),
		)
		if (started.ok) notificationService.info('Local Ornith model is running. It will appear under the llama.cpp Server provider momentarily.')
		else notificationService.notify({ severity: Severity.Error, message: started.error })
	}
});
