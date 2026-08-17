/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The RLM REPL worker. This function is never called in the main process - it is
// stringified (Function.prototype.toString) and run in a separate node process via
// `process.execPath -e "(<source>)()"` with ELECTRON_RUN_AS_NODE=1 (see rlmReplChannel.ts).
// That keeps model-written code out of the main process (an infinite loop only hangs the
// worker, which the parent watchdog kills), with zero build-system changes.
//
// It must therefore be fully self-contained: no imports from this codebase, node builtins
// only via require.
//
// Protocol (line-delimited JSON on stdio):
//   parent -> worker:  { type: 'init', id, parts, subcall, truncateChars }
//                      { type: 'exec', id, code }
//   worker -> parent:  { type: 'ready', id, totalChars }
//                      { type: 'execResult', id, output }
//                      { type: 'error', id, error }
//
// Model-visible REPL API (all synchronous - sub-LLM calls block via execFileSync, so the
// model never needs async/await): context, llm_query, llm_query_batched, rlm_query
// (depth-1: aliases llm_query), SHOW_VARS, print/console.log.
//
// NOT a security boundary: node's vm isolates by convention, not against a determined
// escape - same caveat as the reference RLM implementation's local REPL.

// invoked as `(<source>)(require)` - node's -e scripts have CJS require in scope
export function rlmReplWorkerMain(nodeRequire: (m: string) => any) {
	const vm = nodeRequire('vm')
	const util = nodeRequire('util')
	const readline = nodeRequire('readline')
	const proc = nodeRequire('process')
	const { execFileSync } = nodeRequire('child_process')

	// child source for one blocking batch of sub-LLM calls: reads request JSON on stdin,
	// fetches with bounded concurrency, writes result JSON to stdout
	const FETCH_SRC = `
		let b = '';
		process.stdin.on('data', d => b += d).on('end', async () => {
			const q = JSON.parse(b);
			const lim = Math.max(1, q.concurrency || 4);
			let i = 0;
			const out = new Array(q.prompts.length);
			async function worker() {
				while (i < q.prompts.length) {
					const k = i++;
					try {
						const ac = new AbortController();
						const t = setTimeout(() => ac.abort(), q.timeoutMs || 300000);
						const r = await fetch(q.url, {
							method: 'POST',
							headers: Object.assign({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (q.apiKey || 'noop') }, q.headers || {}),
							body: JSON.stringify({ model: q.model, messages: [{ role: 'user', content: q.prompts[k] }], stream: false }),
							signal: ac.signal,
						});
						clearTimeout(t);
						if (!r.ok) {
							out[k] = { ok: false, error: 'HTTP ' + r.status + ': ' + (await r.text()).slice(0, 500) };
						} else {
							const j = await r.json();
							const choice = (j.choices || [])[0] || {};
							out[k] = { ok: true, content: (choice.message && choice.message.content) || '' };
						}
					} catch (e) {
						out[k] = { ok: false, error: String((e && e.message) || e) };
					}
				}
			}
			await Promise.all(Array.from({ length: Math.min(lim, q.prompts.length) }, worker));
			process.stdout.write(JSON.stringify(out));
		});
	`

	let cfg: any = null // { subcall, truncateChars }
	let sandbox: any = null
	let vmContext: any = null
	let scaffold: any = null
	let outBuf: string[] = []

	const callLLMBatch = (prompts: string[]): string[] => {
		const perCallMs = cfg.subcall.timeoutMs || 300000
		const waves = Math.ceil(prompts.length / Math.max(1, cfg.subcall.concurrency || 4))
		try {
			const res = execFileSync(proc.execPath, ['-e', FETCH_SRC], {
				env: Object.assign({}, proc.env, { ELECTRON_RUN_AS_NODE: '1' }),
				input: JSON.stringify({ ...cfg.subcall, prompts }),
				timeout: perCallMs * waves + 30000,
				maxBuffer: 256 * 1024 * 1024,
				windowsHide: true,
			})
			const arr = JSON.parse(res.toString())
			// errors are returned in-band as strings, so model code can inspect and recover
			return arr.map((r: any) => r.ok ? r.content : 'Error: ' + r.error)
		} catch (e: any) {
			return prompts.map(() => 'Error: sub-LLM call failed: ' + String((e && e.message) || e))
		}
	}

	const setupSession = (msg: any) => {
		cfg = { subcall: msg.subcall, truncateChars: msg.truncateChars || 20000 }
		const contextStr = (msg.parts as { name: string, text: string }[])
			.map(p => '===== ' + p.name + ' =====\n' + p.text)
			.join('\n\n')

		const llm_query = (prompt: any, _model?: any): string => callLLMBatch([String(prompt)])[0]
		const llm_query_batched = (prompts: any, _model?: any): string[] => {
			if (!Array.isArray(prompts)) throw new Error('llm_query_batched takes an array of strings')
			return callLLMBatch(prompts.map(String))
		}
		const print = (...args: any[]) => { outBuf.push(util.format(...args)) }

		scaffold = {
			context: contextStr,
			llm_query,
			llm_query_batched,
			rlm_query: llm_query, // depth-1 configuration: recursive sub-calls degrade to plain sub-LLM calls
			rlm_query_batched: llm_query_batched,
			print,
			console: { log: print, info: print, warn: print, error: print, debug: print },
			SHOW_VARS: () => '',
		}
		sandbox = {}
		const scaffoldNames = new Set(Object.keys(scaffold))
		scaffold.SHOW_VARS = () => {
			const vars = Object.keys(sandbox).filter(k => !scaffoldNames.has(k))
			return vars.length === 0
				? 'No user variables defined yet. (Only `var`-declared variables are listed.)'
				: 'Variables: ' + vars.map(k => k + ' (' + typeof sandbox[k] + ')').join(', ')
		}
		Object.assign(sandbox, scaffold)
		vmContext = vm.createContext(sandbox)
		return contextStr.length
	}

	// re-bind scaffold names after every exec so `context = null` etc. can't corrupt the session
	const restoreScaffold = () => {
		for (const k of Object.keys(scaffold)) {
			if (sandbox[k] !== scaffold[k]) sandbox[k] = scaffold[k]
		}
	}

	const exec = (code: string): string => {
		outBuf = []
		let errStr = ''
		try {
			// no vm timeout: llm_query blocks in native execFileSync, which a vm watchdog would
			// falsely count against JS time. Runaway loops are killed by the parent's watchdog.
			vm.runInContext(code, vmContext, { displayErrors: true })
		} catch (e: any) {
			errStr = (e && e.stack) ? String(e.stack).split('\n').slice(0, 8).join('\n') : String(e)
		}
		restoreScaffold()
		let output = outBuf.join('\n')
		if (errStr) output += (output ? '\n' : '') + 'Execution error:\n' + errStr
		if (!output.trim()) output = '(no output. Only print(...) / console.log(...) output is shown - bare expressions are discarded.)'
		const cap = cfg.truncateChars
		if (output.length > cap) output = output.slice(0, cap) + '\n... +[' + (output.length - cap) + ' chars truncated. print() less at once, or push long text through llm_query instead.]'
		return output
	}

	const send = (obj: any) => { proc.stdout.write(JSON.stringify(obj) + '\n') }

	const rl = readline.createInterface({ input: proc.stdin, terminal: false })
	rl.on('line', (line: string) => {
		let msg: any
		try { msg = JSON.parse(line) } catch { return }
		try {
			if (msg.type === 'init') {
				const totalChars = setupSession(msg)
				send({ type: 'ready', id: msg.id, totalChars })
			}
			else if (msg.type === 'exec') {
				send({ type: 'execResult', id: msg.id, output: exec(msg.code) })
			}
		} catch (e: any) {
			send({ type: 'error', id: msg.id, error: String((e && e.message) || e) })
		}
	})
	rl.on('close', () => { proc.exit(0) })
}
