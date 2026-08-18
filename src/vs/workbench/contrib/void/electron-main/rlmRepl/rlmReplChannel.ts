/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// registered in app.ts (channel 'void-channel-rlm-repl'), used by common/rlmReplService.ts

import { spawn, ChildProcess } from 'child_process';
import { Event } from '../../../../../base/common/event.js';
import { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { RLMEnsureSessionParams, RLMEnsureSessionResult, RLMExecParams, RLMExecResult, RLM_EXEC_TIMEOUT_MS } from '../../common/rlmReplTypes.js';
import { rlmReplWorkerMain } from './rlmReplWorker.js';

type RLMSession = {
	proc: ChildProcess;
	fingerprint: string;
	totalChars: number;
	stdoutBuf: string;
	pending: Map<number, (msg: any) => void>;
	nextId: number;
	dead: boolean;
}

const fingerprintOf = (params: RLMEnsureSessionParams) => {
	// ponytail: name+length fingerprint; same-length in-place edits reuse the old context until the thread changes shape
	return JSON.stringify([params.subcall, params.truncateChars, params.parts.map(p => [p.name, p.text.length])])
}

export class RLMReplChannel implements IServerChannel {

	private readonly sessions = new Map<string, RLMSession>()

	listen(_: unknown, event: string): Event<any> {
		throw new Error(`RLMReplChannel: no events (got ${event})`);
	}

	async call(_: unknown, command: string, params: any): Promise<any> {
		if (command === 'ensureSession') return this._ensureSession(params as RLMEnsureSessionParams)
		if (command === 'exec') return this._exec(params as RLMExecParams)
		if (command === 'interrupt') return this._killSession((params as { sessionId: string }).sessionId, 'interrupted')
		if (command === 'disposeSession') return this._killSession((params as { sessionId: string }).sessionId, 'disposed')
		throw new Error(`RLMReplChannel: command "${command}" not recognized.`)
	}

	private _killSession(sessionId: string, reason: string) {
		const s = this.sessions.get(sessionId)
		if (!s) return
		s.dead = true
		this.sessions.delete(sessionId)
		for (const resolve of s.pending.values()) {
			resolve({ type: 'error', error: `REPL was ${reason}.` })
		}
		s.pending.clear()
		try { s.proc.kill('SIGKILL') } catch { }
	}

	private _send(s: RLMSession, msg: any): Promise<any> {
		const id = s.nextId++
		return new Promise<any>(resolve => {
			s.pending.set(id, resolve)
			try {
				s.proc.stdin!.write(JSON.stringify({ ...msg, id }) + '\n')
			} catch (e) {
				s.pending.delete(id)
				resolve({ type: 'error', error: `Could not reach the REPL worker: ${e}` })
			}
		})
	}

	private _spawnWorker(sessionId: string, fingerprint: string): RLMSession {
		const src = `(${rlmReplWorkerMain.toString()})(require)`
		const proc = spawn(process.execPath, ['-e', src], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		})
		const session: RLMSession = { proc, fingerprint, totalChars: 0, stdoutBuf: '', pending: new Map(), nextId: 1, dead: false }

		proc.stdout!.on('data', (d: Buffer) => {
			session.stdoutBuf += d.toString()
			let idx: number
			while ((idx = session.stdoutBuf.indexOf('\n')) !== -1) {
				const line = session.stdoutBuf.slice(0, idx)
				session.stdoutBuf = session.stdoutBuf.slice(idx + 1)
				if (!line.trim()) continue
				let msg: any
				try { msg = JSON.parse(line) } catch { continue }
				const resolve = session.pending.get(msg.id)
				if (resolve) { session.pending.delete(msg.id); resolve(msg) }
			}
		})
		proc.stderr!.on('data', () => { }) // worker noise; protocol is stdout-only
		proc.on('exit', () => {
			if (!session.dead) {
				session.dead = true
				if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
				for (const resolve of session.pending.values()) resolve({ type: 'error', error: 'The REPL worker exited unexpectedly.' })
				session.pending.clear()
			}
		})
		proc.on('error', () => { /* handled via 'exit' */ })
		return session
	}

	private async _ensureSession(params: RLMEnsureSessionParams): Promise<RLMEnsureSessionResult> {
		const fingerprint = fingerprintOf(params)
		const existing = this.sessions.get(params.sessionId)
		if (existing && !existing.dead && existing.fingerprint === fingerprint) {
			return { totalChars: existing.totalChars } // keep session (and its variables) across turns
		}
		if (existing) this._killSession(params.sessionId, 'restarted')

		const session = this._spawnWorker(params.sessionId, fingerprint)
		this.sessions.set(params.sessionId, session)

		const readyPromise = this._send(session, { type: 'init', parts: params.parts, subcall: params.subcall, truncateChars: params.truncateChars })
		const timeout = new Promise<any>(res => setTimeout(() => res({ type: 'error', error: 'REPL worker did not start within 30s.' }), 30_000))
		const msg = await Promise.race([readyPromise, timeout])
		if (msg.type !== 'ready') {
			this._killSession(params.sessionId, 'failed to start')
			throw new Error(msg.error || 'REPL worker failed to initialize.')
		}
		session.totalChars = msg.totalChars
		return { totalChars: msg.totalChars }
	}

	private async _exec(params: RLMExecParams): Promise<RLMExecResult> {
		const session = this.sessions.get(params.sessionId)
		if (!session || session.dead) {
			return { output: 'Error: no active REPL session. It may have been interrupted or timed out; re-send your message to start a fresh one.' }
		}
		const resPromise = this._send(session, { type: 'exec', code: params.code })
		// watchdog: the worker is single-threaded; a runaway loop can only be stopped by killing it
		const timeout = new Promise<any>(res => setTimeout(() => res({ type: 'timeout' }), RLM_EXEC_TIMEOUT_MS))
		const msg = await Promise.race([resPromise, timeout])
		if (msg.type === 'execResult') return { output: msg.output }
		if (msg.type === 'timeout') {
			this._killSession(params.sessionId, 'killed after timing out')
			return { output: `Error: REPL execution timed out after ${RLM_EXEC_TIMEOUT_MS / 1000}s and the REPL was restarted. All variables are lost. Use smaller steps.` }
		}
		return { output: `Error: ${msg.error || 'unknown REPL error'}` }
	}
}
