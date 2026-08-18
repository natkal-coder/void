/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Manages Google LiteRT-LM (litert-community models) as RecurseIDE's lightweight local tier.
// LiteRT-LM ships as a Python >=3.10 CLI whose `litert-lm serve` exposes an official
// OpenAI-compatible API (GET /v1/models, POST /v1/chat/completions, streaming) - so there
// is no custom bridge here: we bootstrap a private venv in <userData>/litert, `pip install
// litert-lm`, import models via `litert-lm import --from-huggingface-repo ...` (the CLI does
// its own download into ~/.litert-lm), and run `litert-lm serve` on LITERT_SERVER_PORT.
// The existing liteRT provider then autodetects models like any OpenAI-compatible endpoint.
// Machines without Python >= 3.10 get an actionable error; bundling a Python runtime is a
// deliberate non-goal for now.
// registered in app.ts (channel 'void-channel-litert'), used by common/liteRTManagerService.ts

import { app } from 'electron';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import * as os from 'os';
import { LiteRTStatus, LiteRTProgress, LITERT_SERVER_PORT, LITERT_DEFAULT_MODEL, LITERT_MAX_NUM_TOKENS } from '../../common/liteRTManagerTypes.js';

const MODELS_URL = `http://127.0.0.1:${LITERT_SERVER_PORT}/v1/models`

const fetchModelIds = async (): Promise<string[] | null> => {
	try {
		const ac = new AbortController()
		const t = setTimeout(() => ac.abort(), 2500)
		const r = await fetch(MODELS_URL, { signal: ac.signal })
		clearTimeout(t)
		if (!r.ok) return null
		const j: any = await r.json()
		return (j.data ?? []).map((m: any) => String(m.id))
	} catch { return null }
}

export class LiteRTManagerChannel implements IServerChannel {

	private readonly _onProgress = new Emitter<LiteRTProgress>()
	private serverProc: ChildProcess | null = null
	private setupAbort: AbortController | null = null

	constructor() {
		this._autoStart().catch(() => { })
		app.once('will-quit', () => { try { this.serverProc?.kill() } catch { } })
	}

	listen(_: unknown, event: string): Event<any> {
		if (event === 'onProgress_liteRT') return this._onProgress.event;
		throw new Error(`LiteRTManagerChannel: no event "${event}"`);
	}

	async call(_: unknown, command: string, params: any): Promise<any> {
		if (command === 'status') return this._status()
		if (command === 'setup') return this._setup(params ?? {})
		if (command === 'start') return this._startServe()
		if (command === 'abortSetup') { this.setupAbort?.abort(); return }
		throw new Error(`LiteRTManagerChannel: command "${command}" not recognized.`)
	}

	private get venvDir() { return path.join(app.getPath('userData'), 'litert', 'venv') }

	private get cliPath() {
		return process.platform === 'win32'
			? path.join(this.venvDir, 'Scripts', 'litert-lm.exe')
			: path.join(this.venvDir, 'bin', 'litert-lm')
	}

	// find a python >= 3.10
	private _findPython(): string | null {
		const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
		for (const cmd of candidates) {
			try {
				const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0]*100+sys.version_info[1])'], { timeout: 10_000, windowsHide: true })
				const v = parseInt((r.stdout ?? '').toString().trim())
				if (!isNaN(v) && v >= 310) return cmd
			} catch { }
		}
		return null
	}

	private async _status(): Promise<LiteRTStatus> {
		const modelIds = await fetchModelIds()
		return {
			pythonOk: this._findPython() !== null,
			cliInstalled: fs.existsSync(this.cliPath),
			serverHealthy: modelIds !== null,
			modelIds: modelIds ?? [],
			port: LITERT_SERVER_PORT,
		}
	}

	private async _autoStart() {
		if (fs.existsSync(this.cliPath) && (await fetchModelIds()) === null) await this._startServe()
	}

	// run a CLI step, streaming its output lines as progress events
	private _run(cmd: string, args: string[], phase: string): Promise<{ code: number, tail: string }> {
		return new Promise(resolve => {
			this._onProgress.fire({ message: phase })
			const p = spawn(cmd, args, { windowsHide: true })
			let tail = ''
			const onData = (d: Buffer) => {
				const line = d.toString().split('\n').filter(l => l.trim()).pop()
				if (line) { tail = line.slice(0, 200); this._onProgress.fire({ message: `${phase}: ${tail}` }) }
			}
			p.stdout?.on('data', onData)
			p.stderr?.on('data', onData)
			const abortSub = () => { try { p.kill() } catch { } }
			this.setupAbort?.signal.addEventListener('abort', abortSub)
			p.on('close', (code) => {
				this.setupAbort?.signal.removeEventListener('abort', abortSub)
				resolve({ code: code ?? 1, tail })
			})
			p.on('error', (e) => resolve({ code: 127, tail: String(e) }))
		})
	}

	private async _setup(opts: { repo?: string, file?: string, id?: string }): Promise<{ ok: true, modelIds: string[] } | { ok: false, error: string }> {
		const repo = opts.repo || LITERT_DEFAULT_MODEL.repo
		const file = opts.file || LITERT_DEFAULT_MODEL.file
		const id = opts.id || LITERT_DEFAULT_MODEL.id
		this.setupAbort = new AbortController()
		try {
			// 1. venv + CLI
			if (!fs.existsSync(this.cliPath)) {
				const python = this._findPython()
				if (!python) return { ok: false, error: 'LiteRT needs Python 3.10+ on your PATH. Install it from python.org (or your package manager) and retry.' }
				fs.mkdirSync(path.dirname(this.venvDir), { recursive: true })
				let r = await this._run(python, ['-m', 'venv', this.venvDir], 'Creating LiteRT environment')
				if (r.code !== 0) return { ok: false, error: `Could not create a Python venv: ${r.tail}` }
				const pip = process.platform === 'win32' ? path.join(this.venvDir, 'Scripts', 'pip.exe') : path.join(this.venvDir, 'bin', 'pip')
				r = await this._run(pip, ['install', '--upgrade', 'litert-lm'], 'Installing LiteRT-LM')
				if (r.code !== 0) return { ok: false, error: `pip install litert-lm failed: ${r.tail}` }
			}
			// 2. import the model (the CLI downloads it into ~/.litert-lm)
			const imp = await this._run(this.cliPath, ['import', '--from-huggingface-repo', repo, file, id], `Downloading ${id} (~${LITERT_DEFAULT_MODEL.sizeGb} GB)`)
			if (imp.code !== 0 && !imp.tail.toLowerCase().includes('exist')) {
				return { ok: false, error: `Model import failed: ${imp.tail}` }
			}
			// 2b. raise the serve-side context ceiling for this model - litert serve returns
			// HTTP 500 on prompts beyond its configured max_num_tokens (default is small)
			this._writeModelConfig(id, { max_num_tokens: LITERT_MAX_NUM_TOKENS })
			// 3. serve
			const started = await this._startServe()
			if (!started.ok) return started
			const modelIds = await fetchModelIds()
			return { ok: true, modelIds: modelIds ?? [] }
		}
		finally {
			this.setupAbort = null
		}
	}

	// merge per-model settings into ~/.litert-lm/config.json without clobbering user edits
	private _writeModelConfig(modelId: string, settings: { [k: string]: unknown }) {
		try {
			const cfgPath = path.join(os.homedir(), '.litert-lm', 'config.json')
			let cfg: any = {}
			try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch { }
			cfg.models = cfg.models ?? {}
			cfg.models[modelId] = { ...cfg.models[modelId], ...settings }
			fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
			fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
		} catch { /* config is an optimization; serve still works without it */ }
	}

	private async _startServe(): Promise<{ ok: true } | { ok: false, error: string }> {
		if (await fetchModelIds() !== null) return { ok: true } // something already serves the port
		if (!fs.existsSync(this.cliPath)) return { ok: false, error: 'LiteRT-LM is not set up yet. Run "RecurseIDE: Set Up LiteRT Models".' }

		try { this.serverProc?.kill() } catch { }
		this.serverProc = spawn(this.cliPath, ['serve', '--host', '127.0.0.1', '--port', String(LITERT_SERVER_PORT)], { stdio: 'ignore', windowsHide: true })
		this.serverProc.on('error', () => { this.serverProc = null })

		for (let i = 0; i < 60; i++) {
			if (await fetchModelIds() !== null) return { ok: true }
			if (this.serverProc === null || this.serverProc.exitCode !== null) return { ok: false, error: 'litert-lm serve exited during startup.' }
			await new Promise(res => setTimeout(res, 1000))
		}
		return { ok: false, error: 'litert-lm serve did not become healthy within 60s.' }
	}
}
