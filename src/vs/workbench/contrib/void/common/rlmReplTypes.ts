/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Types for the RLM (Recursive Language Model) REPL.
// The REPL is a sandboxed JS interpreter running in a separate node process (main-process side).
// The root LLM interacts with it via the `run_repl` tool; inside the REPL, `llm_query` /
// `llm_query_batched` make synchronous sub-LLM calls against an OpenAI-compatible endpoint.
// Method reference: "Recursive Language Models" (Zhang, 2025) - depth-1 configuration.

export type RLMContextPart = {
	name: string, // a display name for the part (usually a file path)
	text: string,
}

// resolved OpenAI-compatible endpoint the REPL worker calls directly for sub-LLM queries
export type RLMSubcallConfig = {
	url: string, // full URL of the /chat/completions endpoint
	apiKey: string,
	headers: { [k: string]: string },
	model: string,
	concurrency: number,
	timeoutMs: number,
}

export type RLMEnsureSessionParams = {
	sessionId: string,
	parts: RLMContextPart[],
	subcall: RLMSubcallConfig,
	truncateChars: number, // REPL output shown back to the root LLM is truncated to this
}

export type RLMEnsureSessionResult = { totalChars: number }

export type RLMExecParams = {
	sessionId: string,
	code: string,
}

export type RLMExecResult = { output: string }

// info threaded into the rlm-mode system prompt
export type RLMContextInfo = {
	totalChars: number,
	partNames: string[],
	truncateChars: number,
	subcallCharBudget: number, // suggested max chars per llm_query prompt
}

export const RLM_DEFAULT_TRUNCATE_CHARS = 20_000
export const RLM_EXEC_TIMEOUT_MS = 10 * 60 * 1000 // per run_repl call; sub-LLM chains on local models are slow
export const RLM_SUBCALL_TIMEOUT_MS = 5 * 60 * 1000 // per individual sub-LLM call
