/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type LlamaManagerStatus = {
	serverHealthy: boolean,
	binaryPath: string | null,
	modelPath: string | null,
	downloadDir: string,
	port: number,
}

export type LlamaDownloadProgress = { received: number, total: number }

export const ORNITH_SERVER_PORT = 8086 // must match defaultProviderSettings.llamaServer.endpoint

// ornith-ai/Ornith-1.0-9B-GGUF is public, MIT-licensed. Q4_K_M (5.63GB) is the default so
// 8GB-RAM machines can run it; swap to ornith-1.0-9b-Q8_0.gguf (9.53GB) for max quality.
// The manager is model-agnostic: any .gguf placed in the ornith dir (e.g. a Gemma quant) works.
export const ORNITH_DEFAULT_MODEL_URL = 'https://huggingface.co/ornith-ai/Ornith-1.0-9B-GGUF/resolve/main/ornith-1.0-9b-Q4_K_M.gguf'
export const ORNITH_MODEL_SIZE_GB = 5.7
