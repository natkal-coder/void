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

// default lightweight model: apache-2.0, ungated, 2.59GB, up to 32K context, runs on CPU
export const LITERT_DEFAULT_MODEL = {
	repo: 'litert-community/gemma-4-E2B-it-litert-lm',
	file: 'gemma-4-E2B-it.litertlm',
	id: 'gemma-4-E2B-it',
	sizeGb: 2.6,
}
