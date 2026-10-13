import { DatabaseSync } from 'node:sqlite'

import app from '../src/studio.app'

import type { SQLInputValue } from 'node:sqlite'
import type { Env } from '../src/context'

const database = new DatabaseSync(':memory:')
export const objects = new Map<string, Uint8Array>()
const DB = {
	prepare(sql: string) {
		let parameters: SQLInputValue[] = []
		const statement = {
			bind(...values: SQLInputValue[]) {
				parameters = values
				return statement
			},
			async run() {
				const result = database.prepare(sql).run(...parameters)
				return {
					success: true,
					meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
				}
			},
			async all() {
				return { success: true, results: database.prepare(sql).all(...parameters) }
			},
			async first(column?: string) {
				const row = database.prepare(sql).get(...parameters)
				return row == null ? null : column ? row[column] : row
			},
		}
		return statement
	},
	async batch(statements: Array<{ run(): Promise<unknown> }>) {
		database.exec('SAVEPOINT batch')
		try {
			const results = []
			for (const stmt of statements) results.push(await stmt.run())
			database.exec('RELEASE batch')
			return results
		} catch (error) {
			database.exec('ROLLBACK TO batch; RELEASE batch')
			throw error
		}
	},
}

let secret = ''
export const env = {
	DB,
	JWT_SECRET: {
		async get() {
			return secret
		},
	},
	ENVIRONMENT: 'VITEST',
	NAME: 'studio',
	SENTRY_RELEASE: 'test',
	CDN_ASSETS: {
		async put(key: string, bytes: ArrayBuffer | Uint8Array) {
			objects.set(key, new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.slice()))
		},
		async get(key: string) {
			const bytes = objects.get(key)
			return bytes == null
				? null
				: {
						async arrayBuffer() {
							return bytes.slice().buffer
						},
						async text() {
							return new TextDecoder().decode(bytes)
						},
					}
		},
		async delete(key: string) {
			objects.delete(key)
		},
	},
}
export const adminSecretsStore = (_: unknown) => ({
	async create(value: string) {
		secret = value
	},
})
export const SELF = {
	fetch(input: RequestInfo | URL, init?: RequestInit) {
		// This adapter implements only the binding methods exercised by these routes.
		return app.fetch(new Request(input, init), env as unknown as Env)
	},
}
export function beginTest() {
	database.exec('SAVEPOINT test')
}
export function endTest() {
	database.exec('ROLLBACK TO test; RELEASE test')
	objects.clear()
}
