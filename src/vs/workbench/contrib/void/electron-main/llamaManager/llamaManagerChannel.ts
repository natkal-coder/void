/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Manages the bundled local llama.cpp server + Ornith model.
// Resolution order for the server binary and .gguf model:
//   1. <resources>/ornith        (offline installer variant - see build/ornith-offline-bundle.sh)
//   2. <userData>/ornith         (first-run in-app download)
//   3. $VOID_ORNITH_DIR          (dev override)
// registered in app.ts (channel 'void-channel-llama-manager'), used by common/llamaManagerService.ts

import { app } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { LlamaManagerStatus, LlamaDownloadProgress, ORNITH_DEFAULT_MODEL_URL, ORNITH_SERVER_PORT } from '../../common/llamaManagerTypes.js';

const HEALTH_URL = `http://127.0.0.1:${ORNITH_SERVER_PORT}/health`

const isHealthy = async (): Promise<boolean> => {
	try {
		const ac = new AbortController()
		const t = setTimeout(() => ac.abort(), 2000)
		const r = await fetch(HEALTH_URL, { signal: ac.signal })
		clearTimeout(t)
		return r.ok
	} catch { return false }
}

export class LlamaManagerChannel implements IServerChannel {

	private readonly _onProgress = new Emitter<LlamaDownloadProgress>()
	private serverProc: ChildProcess | null = null
	private downloadAbort: AbortController | null = null

	constructor() {
		// bundled + already-downloaded installs should just work with zero clicks
		this._autoStart().catch(() => { })
		app.once('will-quit', () => { try { this.serverProc?.kill() } catch { } })
	}

	listen(_: unknown, event: string): Event<any> {
		if (event === 'onProgress_llamaManager') return this._onProgress.event;
		throw new Error(`LlamaManagerChannel: no event "${event}"`);
	}

	async call(_: unknown, command: string, params: any): Promise<any> {
		if (command === 'status') return this._status()
		if (command === 'start') return this._start()
		if (command === 'downloadModel') return this._downloadModel(params?.url)
		if (command === 'abortDownload') { this.downloadAbort?.abort(); return }
		throw new Error(`LlamaManagerChannel: command "${command}" not recognized.`)
	}

	private _candidateDirs(): string[] {
		const dirs: string[] = []
		const resourcesPath = (process as any).resourcesPath
		if (resourcesPath) dirs.push(path.join(resourcesPath, 'ornith'))
		dirs.push(path.join(app.getPath('userData'), 'ornith'))
		if (process.env['VOID_ORNITH_DIR']) dirs.push(process.env['VOID_ORNITH_DIR']!)
		return dirs
	}

	private _find(): { binaryPath: string | null, modelPath: string | null, downloadDir: string } {
		const binaryName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
		let binaryPath: string | null = null
		let modelPath: string | null = null
		for (const dir of this._candidateDirs()) {
			try {
				if (!binaryPath && fs.existsSync(path.join(dir, binaryName))) binaryPath = path.join(dir, binaryName)
				if (!modelPath) {
					const gguf = fs.readdirSync(dir).find(f => f.endsWith('.gguf'))
					if (gguf) modelPath = path.join(dir, gguf)
				}
			} catch { }
		}
		return { binaryPath, modelPath, downloadDir: path.join(app.getPath('userData'), 'ornith') }
	}

	private async _status(): Promise<LlamaManagerStatus> {
		const { binaryPath, modelPath, downloadDir } = this._find()
		return { serverHealthy: await isHealthy(), binaryPath, modelPath, downloadDir, port: ORNITH_SERVER_PORT }
	}

	private async _autoStart() {
		const { binaryPath, modelPath } = this._find()
		if (binaryPath && modelPath && !(await isHealthy())) await this._start()
	}

	private async _start(): Promise<{ ok: true } | { ok: false, error: string }> {
		if (await isHealthy()) return { ok: true } // something (possibly user-managed) already serves the port
		const { binaryPath, modelPath } = this._find()
		if (!binaryPath) return { ok: false, error: `llama-server binary not found. Expected in ${this._candidateDirs().join(' or ')}.` }
		if (!modelPath) return { ok: false, error: `No .gguf model found. Run "RecurseIDE: Set Up Local Ornith Model" to download it.` }

		try { this.serverProc?.kill() } catch { }
		// flags mirror the reference Ornith deployment; -ngl 99 is a no-op without a GPU build
		this.serverProc = spawn(binaryPath, [
			'-m', modelPath,
			'--host', '127.0.0.1', '--port', String(ORNITH_SERVER_PORT),
			'-ngl', '99', '-c', '32768', '--jinja',
		], { stdio: 'ignore', windowsHide: true })
		this.serverProc.on('error', () => { this.serverProc = null })

		for (let i = 0; i < 120; i++) {
			if (await isHealthy()) return { ok: true }
			if (this.serverProc === null || this.serverProc.exitCode !== null) return { ok: false, error: 'llama-server exited during startup (bad binary for this machine, or not enough memory for the model).' }
			await new Promise(res => setTimeout(res, 1000))
		}
		return { ok: false, error: 'llama-server did not become healthy within 120s.' }
	}

	private async _downloadModel(url?: string): Promise<{ ok: true, modelPath: string } | { ok: false, error: string }> {
		const { downloadDir, modelPath: existing } = this._find()
		if (existing) return { ok: true, modelPath: existing }

		const dlUrl = url || ORNITH_DEFAULT_MODEL_URL
		const fileName = decodeURIComponent(new URL(dlUrl).pathname.split('/').pop() || 'model.gguf')
		if (!fileName.endsWith('.gguf')) return { ok: false, error: `Refusing to download non-gguf file: ${fileName}` }
		const partPath = path.join(downloadDir, fileName + '.part')
		const finalPath = path.join(downloadDir, fileName)
		fs.mkdirSync(downloadDir, { recursive: true })

		const startAt = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
		this.downloadAbort = new AbortController()
		try {
			const res = await fetch(dlUrl, {
				headers: startAt > 0 ? { Range: `bytes=${startAt}-` } : {},
				signal: this.downloadAbort.signal,
				redirect: 'follow',
			})
			if (!res.ok || !res.body) return { ok: false, error: `Download failed: HTTP ${res.status}. If the model repo is gated, host the .gguf somewhere public and pass its URL.` }
			const resuming = res.status === 206
			const total = (resuming ? startAt : 0) + Number(res.headers.get('content-length') || 0)
			let received = resuming ? startAt : 0
			const out = fs.createWriteStream(partPath, { flags: resuming ? 'a' : 'w' })
			let lastEmit = 0
			for await (const chunk of res.body as any) {
				out.write(chunk)
				received += chunk.length
				const now = Date.now()
				if (now - lastEmit > 500) { lastEmit = now; this._onProgress.fire({ received, total }) }
			}
			await new Promise<void>((resolve, reject) => out.end((e: any) => e ? reject(e) : resolve()))
			this._onProgress.fire({ received, total })
			fs.renameSync(partPath, finalPath)
			return { ok: true, modelPath: finalPath }
		}
		catch (e: any) {
			if (this.downloadAbort?.signal.aborted) return { ok: false, error: 'Download cancelled. Re-run setup to resume where it left off.' }
			return { ok: false, error: `Download failed: ${e?.message || e}` }
		}
		finally {
			this.downloadAbort = null
		}
	}
}
