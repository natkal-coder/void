/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVoidSettingsService } from './voidSettingsService.js';
import { ModelSelection, SettingsOfProvider } from './voidSettingsTypes.js';
import { getModelCapabilities } from './modelCapabilities.js';
import { RLMContextInfo, RLMContextPart, RLMEnsureSessionResult, RLMExecResult, RLMSubcallConfig, RLM_DEFAULT_TRUNCATE_CHARS, RLM_SUBCALL_TIMEOUT_MS } from './rlmReplTypes.js';

export interface IRLMReplService {
	readonly _serviceBrand: undefined;
	// creates (or reuses) the REPL session for a thread and marks it active; returns prompt-facing context info, or an error string
	ensureSessionForThread(threadId: string, parts: RLMContextPart[], modelSelection: ModelSelection): Promise<{ info: RLMContextInfo } | { error: string }>;
	// runs code in the active session (the one from the last ensureSessionForThread call)
	exec(code: string): { resPromise: Promise<RLMExecResult>, interrupt: () => void };
}

export const IRLMReplService = createDecorator<IRLMReplService>('RLMReplService');

const CHARS_PER_TOKEN = 3 // conservative for code

// resolve the OpenAI-compatible chat/completions URL for sub-LLM calls made from inside the REPL.
// The REPL worker calls the endpoint directly (it is a plain node process), so only providers
// with a known OpenAI-compatible base URL are supported in RLM mode.
// ponytail: mirrors the baseURL logic of newOpenAICompatibleSDK (sendLLMMessage.impl.ts); unify if a third copy appears
const subcallConfigForSelection = (modelSelection: ModelSelection, settingsOfProvider: SettingsOfProvider): RLMSubcallConfig | { error: string } => {
	const { providerName, modelName } = modelSelection
	const common = { model: modelName, concurrency: 4, timeoutMs: RLM_SUBCALL_TIMEOUT_MS, headers: {} as { [k: string]: string } }

	if (providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio' || providerName === 'llamaServer' || providerName === 'liteRT' || providerName === 'liteLLM') {
		const { endpoint } = settingsOfProvider[providerName]
		return { ...common, url: `${endpoint}/v1/chat/completions`, apiKey: 'noop' }
	}
	if (providerName === 'openAICompatible') {
		const { endpoint, apiKey, headersJSON } = settingsOfProvider.openAICompatible
		let headers: { [k: string]: string } = {}
		try { headers = JSON.parse(headersJSON || '{}') } catch { }
		return { ...common, url: `${endpoint.replace(/\/+$/, '')}/chat/completions`, apiKey, headers }
	}
	if (providerName === 'openAI') return { ...common, url: 'https://api.openai.com/v1/chat/completions', apiKey: settingsOfProvider.openAI.apiKey }
	if (providerName === 'deepseek') return { ...common, url: 'https://api.deepseek.com/v1/chat/completions', apiKey: settingsOfProvider.deepseek.apiKey }
	if (providerName === 'groq') return { ...common, url: 'https://api.groq.com/openai/v1/chat/completions', apiKey: settingsOfProvider.groq.apiKey }
	if (providerName === 'xAI') return { ...common, url: 'https://api.x.ai/v1/chat/completions', apiKey: settingsOfProvider.xAI.apiKey }
	if (providerName === 'mistral') return { ...common, url: 'https://api.mistral.ai/v1/chat/completions', apiKey: settingsOfProvider.mistral.apiKey }
	if (providerName === 'openRouter') return { ...common, url: 'https://openrouter.ai/api/v1/chat/completions', apiKey: settingsOfProvider.openRouter.apiKey }

	return { error: `RLM mode requires an OpenAI-compatible provider (local llama.cpp Server, Ollama, vLLM, LM Studio, OpenAI, etc.). "${providerName}" is not supported yet - switch the Chat model or the chat mode.` }
}

class RLMReplService extends Disposable implements IRLMReplService {
	readonly _serviceBrand: undefined;
	private readonly channel: IChannel

	// ponytail: one active RLM session per window; two threads running RLM concurrently would share it - key by thread if that ever matters
	private activeSessionId: string | null = null

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
	) {
		super()
		this.channel = mainProcessService.getChannel('void-channel-rlm-repl')
	}

	async ensureSessionForThread(threadId: string, parts: RLMContextPart[], modelSelection: ModelSelection): Promise<{ info: RLMContextInfo } | { error: string }> {
		const { settingsOfProvider, overridesOfModel } = this.voidSettingsService.state

		const subcall = subcallConfigForSelection(modelSelection, settingsOfProvider)
		if ('error' in subcall) return { error: subcall.error }

		// scale REPL feedback and per-subcall prompt size to the model's context window,
		// so a small local root model (e.g. Ornith 9B) doesn't blow its own context with REPL output
		const { contextWindow } = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel)
		const truncateChars = Math.max(2_000, Math.min(RLM_DEFAULT_TRUNCATE_CHARS, Math.floor(contextWindow * CHARS_PER_TOKEN / 8)))
		const subcallCharBudget = Math.floor(contextWindow * CHARS_PER_TOKEN * 0.6)

		try {
			const res: RLMEnsureSessionResult = await this.channel.call('ensureSession', {
				sessionId: threadId, parts, subcall, truncateChars,
			})
			this.activeSessionId = threadId
			return { info: { totalChars: res.totalChars, partNames: parts.map(p => p.name), truncateChars, subcallCharBudget } }
		}
		catch (e) {
			return { error: `Could not start the RLM REPL: ${e}` }
		}
	}

	exec(code: string): { resPromise: Promise<RLMExecResult>, interrupt: () => void } {
		const sessionId = this.activeSessionId
		if (!sessionId) {
			return { resPromise: Promise.resolve({ output: 'Error: no active REPL session.' }), interrupt: () => { } }
		}
		const resPromise: Promise<RLMExecResult> = this.channel.call('exec', { sessionId, code })
		const interrupt = () => { this.channel.call('interrupt', { sessionId }) }
		return { resPromise, interrupt }
	}
}

registerSingleton(IRLMReplService, RLMReplService, InstantiationType.Delayed);
