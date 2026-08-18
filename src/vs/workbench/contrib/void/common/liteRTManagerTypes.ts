/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type LiteRTStatus = {
	pythonOk: boolean, // python >= 3.10 found
	cliInstalled: boolean, // litert-lm present in our venv
	serverHealthy: boolean,
	modelIds: string[], // from GET /v1/models when healthy
	port: number,
}

export type LiteRTProgress = { message: string }

export const LITERT_SERVER_PORT = 8087 // must match defaultProviderSettings.liteRT.endpoint

// default lightweight model: gemma-4 E2B GPU build - apache-2.0, ungated, 2.0GB download,
// ~1GB VRAM at our token limit so it fits <2GB-VRAM laptop GPUs. The CPU build
// (gemma-4-E2B-it.litertlm, 2.59GB) is the fallback for machines with no GPU.
export const LITERT_DEFAULT_MODEL = {
	repo: 'litert-community/gemma-4-E2B-it-litert-lm',
	file: 'gemma-4-E2B-it-gpu.litertlm',
	id: 'gemma-4-E2B-it',
	sizeGb: 2.0,
}

// serve-side context ceiling written into ~/.litert-lm/config.json per imported model.
// 8192 keeps the GPU KV cache around a gigabyte (the <2GB-VRAM budget) while being large
// enough for RLM sub-queries; litert serve 500s on prompts beyond its configured limit.
export const LITERT_MAX_NUM_TOKENS = 8_192
