import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Telemetry } from "@kilocode/kilo-telemetry" // kilocode_change
import { capture } from "@/kilocode/instance" // kilocode_change

export const OAUTH_DUMMY_KEY = "kilo-oauth-dummy-key" // kilocode_change
export const ACCOUNT_ACTION_SENTINEL = "__kilo_account_action__" // kilocode_change
export const KEEP_EXISTING_KEY_SENTINEL = "__keep_existing_key__" // kilocode_change

const file = path.join(Global.Path.data, "auth.json")
const accountsFile = path.join(Global.Path.data, "auth-accounts.json") // kilocode_change

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
  baseURL: Schema.optional(Schema.String), // kilocode_change - Azure Entra endpoint captured from OAuth prompts
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// kilocode_change start - Multi-account types and runtime state
export type AccountStatusType = "active" | "standby" | "cooldown" | "error"

export interface AccountEntry {
  id: string
  label: string
  auth: Info
  createdAt: number
  updatedAt: number
}

export interface ProviderAccountPool {
  accounts: AccountEntry[]
  activeAccountId: string
  autoFallback: boolean
  workspaceAccounts?: Record<string, string>
}

export interface PublicAccountInfo {
  id: string
  label: string
  type: "api" | "oauth" | "wellknown"
  maskedHint: string
  status: AccountStatusType
  active: boolean
  priority: number
  cooldownUntil?: number
  lastError?: string
  metadata?: Record<string, string>
}

export interface PublicProviderAccountSummary {
  providerID: string
  activeAccountId: string
  workspaceAccountId?: string
  sessionAccountId?: string
  effectiveAccountId: string
  autoFallback: boolean
  accounts: PublicAccountInfo[]
}

interface RuntimeAccountStatus {
  status: "cooldown" | "error"
  cooldownUntil?: number
  lastError?: string
}

const runtimeStatuses = new Map<string, RuntimeAccountStatus>()
const sessionSelections = new Map<string, Record<string, string>>()
const cachedPools = new Map<string, ProviderAccountPool>()
const lastResolvedAccount = new Map<string, string>()
let activeExecutionSession: { sessionID?: string; directory?: string } | undefined

export function setExecutionSession(ctx: { sessionID?: string; directory?: string } | undefined) {
  activeExecutionSession = ctx
}

export function getExecutionSession() {
  return activeExecutionSession
}

export function getSessionAccountSelection(sessionID: string, providerID: string): string | undefined {
  return sessionSelections.get(sessionID)?.[providerID]
}

export function setSessionAccountSelection(sessionID: string, providerID: string, accountId: string | undefined) {
  const norm = providerID.replace(/\/+$/, "")
  const existing = { ...(sessionSelections.get(sessionID) ?? {}) }
  if (!accountId) {
    delete existing[norm]
  } else {
    existing[norm] = accountId
    runtimeStatuses.delete(`${norm}:${accountId}`)
  }
  if (Object.keys(existing).length === 0) sessionSelections.delete(sessionID)
  else sessionSelections.set(sessionID, existing)
}

export function maskAuthHint(info: Info): string {
  if (info.type === "api") {
    const raw = info.key.trim()
    let hint = "API Key"
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const email = typeof parsed.client_email === "string" ? parsed.client_email : undefined
        const proj = typeof parsed.project_id === "string" ? parsed.project_id : undefined
        hint = email ? `Service Account (${email})` : proj ? `Service Account (${proj})` : "Service Account"
      } catch {
        hint = "Service Account"
      }
    } else if (raw.length >= 10) {
      const prefix = raw.startsWith("sk-ant-")
        ? "sk-ant-"
        : raw.startsWith("sk-")
          ? "sk-"
          : raw.slice(0, 3)
      hint = `${prefix}…${raw.slice(-4)}`
    } else if (raw.length > 4) {
      hint = `…${raw.slice(-3)}`
    }
    const extra = info.metadata?.region ?? info.metadata?.resourceName ?? info.metadata?.project
    return extra ? `${hint} • ${extra}` : hint
  }
  if (info.type === "oauth") {
    if (info.accountId) {
      const id = info.accountId.length > 20 ? `${info.accountId.slice(0, 17)}…` : info.accountId
      return `OAuth • ${id}`
    }
    if (info.enterpriseUrl) return `OAuth • ${info.enterpriseUrl}`
    if (info.baseURL) return `OAuth • ${info.baseURL}`
    return "OAuth"
  }
  return `Token • ${info.key}`
}

function getRuntimeStatus(providerID: string, accountId: string, now = Date.now()): RuntimeAccountStatus | undefined {
  const key = `${providerID}:${accountId}`
  const entry = runtimeStatuses.get(key)
  if (!entry) return undefined
  if (entry.status === "cooldown" && entry.cooldownUntil !== undefined && entry.cooldownUntil <= now) {
    runtimeStatuses.delete(key)
    return undefined
  }
  return entry
}

export function clearAccountStatus(providerID: string, accountId?: string) {
  const norm = providerID.replace(/\/+$/, "")
  if (accountId) {
    runtimeStatuses.delete(`${norm}:${accountId}`)
    return
  }
  for (const key of runtimeStatuses.keys()) {
    if (key.startsWith(`${norm}:`)) runtimeStatuses.delete(key)
  }
}

export function resetRuntimeAccountStateForTests() {
  runtimeStatuses.clear()
  sessionSelections.clear()
  cachedPools.clear()
  lastResolvedAccount.clear()
  activeExecutionSession = undefined
}

function sameAuthInfo(a: Info, b: Info): boolean {
  if (a.type !== b.type) return false
  if (a.type === "api" && b.type === "api") return a.key === b.key
  if (a.type === "oauth" && b.type === "oauth") {
    return a.access === b.access && a.refresh === b.refresh
  }
  if (a.type === "wellknown" && b.type === "wellknown") {
    return a.key === b.key && a.token === b.token
  }
  return false
}

function resolveEffectiveEntry(
  providerID: string,
  pool: ProviderAccountPool,
  opts?: { sessionID?: string; directory?: string; now?: number },
): AccountEntry | undefined {
  if (pool.accounts.length === 0) return undefined
  const now = opts?.now ?? Date.now()
  const sessionID = opts?.sessionID ?? activeExecutionSession?.sessionID
  const directory = opts?.directory ?? activeExecutionSession?.directory ?? capture()?.directory

  const sessionAccountId = sessionID ? sessionSelections.get(sessionID)?.[providerID] : undefined
  const workspaceAccountId = directory ? pool.workspaceAccounts?.[directory] : undefined
  const preferredId = sessionAccountId ?? workspaceAccountId ?? pool.activeAccountId

  const preferredIndex = Math.max(
    0,
    pool.accounts.findIndex((acc) => acc.id === preferredId),
  )
  const preferred = pool.accounts[preferredIndex] ?? pool.accounts[0]!

  if (pool.autoFallback === false || pool.accounts.length <= 1) {
    lastResolvedAccount.set(providerID, preferred.id)
    return preferred
  }

  const preferredStatus = getRuntimeStatus(providerID, preferred.id, now)
  if (!preferredStatus || preferredStatus.status !== "cooldown") {
    lastResolvedAccount.set(providerID, preferred.id)
    return preferred
  }

  // Auto-fallback: check accounts in priority order (starting with highest priority #1,
  // or rotating after the preferred account) for the first non-cooldown account.
  for (let offset = 1; offset < pool.accounts.length; offset++) {
    const idx = (preferredIndex + offset) % pool.accounts.length
    const candidate = pool.accounts[idx]!
    const st = getRuntimeStatus(providerID, candidate.id, now)
    if (!st || st.status !== "cooldown") {
      lastResolvedAccount.set(providerID, candidate.id)
      return candidate
    }
  }

  // All accounts are in cooldown — pick the one whose cooldown expires soonest
  let best = preferred
  let bestUntil = preferredStatus.cooldownUntil ?? Number.POSITIVE_INFINITY
  for (const acc of pool.accounts) {
    const st = getRuntimeStatus(providerID, acc.id, now)
    const until = st?.cooldownUntil ?? 0
    if (until < bestUntil) {
      best = acc
      bestUntil = until
    }
  }
  lastResolvedAccount.set(providerID, best.id)
  return best
}

export function canFallbackToNextAccount(providerID: string): boolean {
  const norm = providerID.replace(/\/+$/, "")
  const pool = cachedPools.get(norm)
  if (!pool || pool.autoFallback === false || pool.accounts.length <= 1) return false
  const now = Date.now()
  const currentId =
    lastResolvedAccount.get(norm) ?? resolveEffectiveEntry(norm, pool, { now })?.id ?? pool.activeAccountId
  return pool.accounts.some((acc) => {
    if (acc.id === currentId) return false
    const st = getRuntimeStatus(norm, acc.id, now)
    return !st || st.status !== "cooldown"
  })
}

/**
 * Called synchronously from SessionRetry.policy when a 429 / rate-limit / quota error occurs.
 * Marks the currently active account as in cooldown and rotates to the next available account
 * if autoFallback is enabled.
 */
export function rotateAccountInMemory(input: {
  providerID: string
  sessionID?: string
  directory?: string
  cooldownMs: number
  message: string
}): { rotated: boolean; previousAccountId?: string; nextAccount?: { id: string; label: string; auth: Info } } {
  const norm = input.providerID.replace(/\/+$/, "")
  const pool = cachedPools.get(norm)
  const now = Date.now()
  const currentEntry = pool
    ? resolveEffectiveEntry(norm, pool, { sessionID: input.sessionID, directory: input.directory, now })
    : undefined
  const failedId = lastResolvedAccount.get(norm) ?? currentEntry?.id ?? "default"

  runtimeStatuses.set(`${norm}:${failedId}`, {
    status: "cooldown",
    cooldownUntil: now + Math.max(input.cooldownMs, 15_000),
    lastError: input.message,
  })

  if (!pool || pool.autoFallback === false || pool.accounts.length <= 1) {
    return { rotated: false, previousAccountId: failedId }
  }

  const next = resolveEffectiveEntry(norm, pool, {
    sessionID: input.sessionID,
    directory: input.directory,
    now,
  })
  if (!next || next.id === failedId) {
    return { rotated: false, previousAccountId: failedId }
  }

  return {
    rotated: true,
    previousAccountId: failedId,
    nextAccount: { id: next.id, label: next.label, auth: next.auth },
  }
}

function buildPublicSummary(
  providerID: string,
  pool: ProviderAccountPool,
  opts?: { directory?: string; sessionID?: string; now?: number },
): PublicProviderAccountSummary {
  const now = opts?.now ?? Date.now()
  const directory = opts?.directory ?? activeExecutionSession?.directory ?? capture()?.directory
  const sessionID = opts?.sessionID ?? activeExecutionSession?.sessionID
  const effective = resolveEffectiveEntry(providerID, pool, { directory, sessionID, now })
  const effectiveId = effective?.id ?? pool.activeAccountId
  const workspaceAccountId = directory ? pool.workspaceAccounts?.[directory] : undefined
  const sessionAccountId = sessionID ? sessionSelections.get(sessionID)?.[providerID] : undefined

  const accounts: PublicAccountInfo[] = pool.accounts.map((acc, index) => {
    const rt = getRuntimeStatus(providerID, acc.id, now)
    const isActive = acc.id === effectiveId
    const status: AccountStatusType =
      rt?.status === "cooldown"
        ? "cooldown"
        : rt?.status === "error"
          ? "error"
          : isActive
            ? "active"
            : "standby"
    const cleanMeta =
      acc.auth.type === "api" && acc.auth.metadata
        ? Object.fromEntries(Object.entries(acc.auth.metadata).filter(([k]) => !k.startsWith("__account")))
        : undefined
    return {
      id: acc.id,
      label: acc.label,
      type: acc.auth.type,
      maskedHint: maskAuthHint(acc.auth),
      status,
      active: isActive,
      priority: index + 1,
      ...(rt?.cooldownUntil ? { cooldownUntil: rt.cooldownUntil } : {}),
      ...(rt?.lastError ? { lastError: rt.lastError } : {}),
      ...(cleanMeta && Object.keys(cleanMeta).length > 0 ? { metadata: cleanMeta } : {}),
    }
  })

  return {
    providerID,
    activeAccountId: pool.activeAccountId,
    ...(workspaceAccountId ? { workspaceAccountId } : {}),
    ...(sessionAccountId ? { sessionAccountId } : {}),
    effectiveAccountId: effectiveId,
    autoFallback: pool.autoFallback !== false,
    accounts,
  }
}
// kilocode_change end

// kilocode_change start
export interface SetAccountOptions {
  accountId?: string
  accountLabel?: string
  accountMode?: "add" | "edit" | "replace"
}
// kilocode_change end

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info, options?: SetAccountOptions) => Effect.Effect<void, AuthError> // kilocode_change
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  // kilocode_change start
  readonly summaries?: (options?: {
    directory?: string
    sessionID?: string
  }) => Effect.Effect<Record<string, PublicProviderAccountSummary>, AuthError>
  // kilocode_change end
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

// kilocode_change start - Helper to parse and normalize ProviderAccountPool records
function sanitizeInfo(info: Info): Info {
  if (info.type !== "api" || !info.metadata) return info
  const entries = Object.entries(info.metadata).filter(([k]) => !k.startsWith("__account"))
  if (entries.length === Object.keys(info.metadata).length) return info
  if (entries.length === 0) {
    return new Api({ type: "api", key: info.key })
  }
  return new Api({ type: "api", key: info.key, metadata: Object.fromEntries(entries) })
}

function extractDirectives(
  info: Info,
  options?: SetAccountOptions,
): {
  clean: Info
  accountId?: string
  accountLabel?: string
  accountMode?: "add" | "edit" | "replace"
  accountAction?: string
  rawMeta: Record<string, string>
} {
  if (info.type !== "api" || !info.metadata) {
    return {
      clean: info,
      accountId: options?.accountId?.trim() || undefined,
      accountLabel: options?.accountLabel?.trim() || undefined,
      accountMode: options?.accountMode,
      rawMeta: {},
    }
  }
  const rawMeta = info.metadata
  const accountId = options?.accountId?.trim() || rawMeta.__accountId?.trim() || undefined
  const accountLabel = options?.accountLabel?.trim() || rawMeta.__accountLabel?.trim() || undefined
  const modeRaw = options?.accountMode ?? rawMeta.__accountMode?.trim()
  const accountMode =
    modeRaw === "add" || modeRaw === "edit" || modeRaw === "replace" ? modeRaw : undefined
  const accountAction = rawMeta.__accountAction?.trim() || undefined
  return {
    clean: sanitizeInfo(info),
    accountId,
    accountLabel,
    accountMode,
    accountAction,
    rawMeta,
  }
}

function generateAccountId(): string {
  return `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}
// kilocode_change end

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    // kilocode_change start - Read raw auth.json and auth-accounts.json
    const readRawAuth = Effect.fn("Auth.readRawAuth")(function* () {
      if (process.env.KILO_AUTH_CONTENT) {
        try {
          const parsed = JSON.parse(process.env.KILO_AUTH_CONTENT) as Record<string, unknown>
          return Record.filterMap(parsed, (value) => Result.fromOption(decode(value), () => undefined))
        } catch (err) {}
      }
      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const readRawPools = Effect.fn("Auth.readRawPools")(function* () {
      if (process.env.KILO_AUTH_CONTENT) {
        return Object.fromEntries(cachedPools.entries())
      }
      const raw = (yield* fsys.readJson(accountsFile).pipe(Effect.orElseSucceed(() => ({})))) as Record<
        string,
        unknown
      >
      const result: Record<string, ProviderAccountPool> = {}
      for (const [providerID, val] of Object.entries(raw)) {
        if (!val || typeof val !== "object" || Array.isArray(val)) continue
        const obj = val as Record<string, unknown>
        if (!Array.isArray(obj.accounts)) continue
        const accounts: AccountEntry[] = []
        for (const item of obj.accounts) {
          if (!item || typeof item !== "object") continue
          const entry = item as Record<string, unknown>
          const decoded = decode(entry.auth)
          if (decoded._tag === "None") continue
          accounts.push({
            id: typeof entry.id === "string" && entry.id ? entry.id : "default",
            label: typeof entry.label === "string" && entry.label ? entry.label : `Account ${accounts.length + 1}`,
            auth: sanitizeInfo(decoded.value),
            createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
            updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
          })
        }
        if (accounts.length === 0) continue
        const activeId =
          typeof obj.activeAccountId === "string" && accounts.some((a) => a.id === obj.activeAccountId)
            ? obj.activeAccountId
            : accounts[0]!.id
        const workspaceAccounts =
          obj.workspaceAccounts && typeof obj.workspaceAccounts === "object" && !Array.isArray(obj.workspaceAccounts)
            ? (obj.workspaceAccounts as Record<string, string>)
            : undefined
        result[providerID] = {
          accounts,
          activeAccountId: activeId,
          autoFallback: obj.autoFallback !== false,
          ...(workspaceAccounts ? { workspaceAccounts } : {}),
        }
      }
      return result
    })

    const resolvePools = Effect.fn("Auth.resolvePools")(function* () {
      const [rawAuth, rawPools] = yield* Effect.all([readRawAuth(), readRawPools()])
      const merged: Record<string, ProviderAccountPool> = {}
      const now = Date.now()
      for (const [providerID, authInfo] of Object.entries(rawAuth)) {
        const cleanAuth = sanitizeInfo(authInfo)
        const existingPool = rawPools[providerID] ?? cachedPools.get(providerID)
        if (existingPool && existingPool.accounts.length > 0) {
          // If auth.json was updated externally (e.g. token refresh), sync the active account's auth
          const matchesAny = existingPool.accounts.some((acc) => sameAuthInfo(acc.auth, cleanAuth))
          const accounts = matchesAny
            ? existingPool.accounts
            : existingPool.accounts.map((acc) =>
                acc.id === existingPool.activeAccountId ? { ...acc, auth: cleanAuth, updatedAt: now } : acc,
              )
          const pool: ProviderAccountPool = {
            ...existingPool,
            accounts,
          }
          merged[providerID] = pool
          cachedPools.set(providerID, pool)
        } else {
          const pool: ProviderAccountPool = {
            accounts: [
              {
                id: "default",
                label: "Account 1",
                auth: cleanAuth,
                createdAt: now,
                updatedAt: now,
              },
            ],
            activeAccountId: "default",
            autoFallback: true,
          }
          merged[providerID] = pool
          cachedPools.set(providerID, pool)
        }
      }
      for (const cachedKey of [...cachedPools.keys()]) {
        if (!(cachedKey in merged)) cachedPools.delete(cachedKey)
      }
      return { rawAuth, pools: merged }
    })

    const writePoolsIfPresent = Effect.fn("Auth.writePoolsIfPresent")(function* (
      pools: Record<string, ProviderAccountPool>,
      forceWrite: boolean,
    ) {
      if (process.env.KILO_AUTH_CONTENT) return
      const exists = yield* fsys.exists(accountsFile).pipe(Effect.orElseSucceed(() => false))
      if (!forceWrite && !exists) return
      yield* fsys
        .writeJson(accountsFile, pools, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth accounts data")))
    })
    // kilocode_change end

    // kilocode_change start
    const all = Effect.fn("Auth.all")(function* () {
      const { rawAuth, pools } = yield* resolvePools()
      const resolved: Record<string, Info> = {}
      for (const [providerID, pool] of Object.entries(pools)) {
        const entry = resolveEffectiveEntry(providerID, pool)
        resolved[providerID] = entry?.auth ?? sanitizeInfo(rawAuth[providerID]!)
      }
      return resolved
    })
    // kilocode_change end

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    // kilocode_change start - Summaries for UI
    const summaries = Effect.fn("Auth.summaries")(function* (options?: {
      directory?: string
      sessionID?: string
    }) {
      const { pools } = yield* resolvePools()
      const now = Date.now()
      const out: Record<string, PublicProviderAccountSummary> = {}
      for (const [providerID, pool] of Object.entries(pools)) {
        out[providerID] = buildPublicSummary(providerID, pool, {
          directory: options?.directory,
          sessionID: options?.sessionID,
          now,
        })
      }
      return out
    })
    // kilocode_change end

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info, options?: SetAccountOptions) { // kilocode_change
      const norm = key.replace(/\/+$/, "")
      // kilocode_change start
      const { rawAuth, pools } = yield* resolvePools()
      const directives = extractDirectives(info, options)

      if (info.type === "api" && info.key === ACCOUNT_ACTION_SENTINEL && directives.accountAction) {
        const action = directives.accountAction
        const meta = directives.rawMeta
        const pool = pools[norm]
        if (!pool) return

        if (action === "select") {
          const accountId = meta.accountId?.trim() ?? ""
          const scope = meta.scope ?? "global"
          const directory = meta.directory?.trim()
          const sessionID = meta.sessionID?.trim()
          if (accountId) clearAccountStatus(norm, accountId)

          if (scope === "session" && sessionID) {
            setSessionAccountSelection(sessionID, norm, accountId || undefined)
          } else if (scope === "workspace" && directory) {
            const nextWs = { ...(pool.workspaceAccounts ?? {}) }
            if (!accountId) delete nextWs[directory]
            else nextWs[directory] = accountId
            pool.workspaceAccounts = Object.keys(nextWs).length > 0 ? nextWs : undefined
          } else if (accountId && pool.accounts.some((a) => a.id === accountId)) {
            pool.activeAccountId = accountId
          }

          cachedPools.set(norm, pool)
          const effective = resolveEffectiveEntry(norm, pool, { directory, sessionID })
          if (effective && !process.env.KILO_AUTH_CONTENT) {
            yield* fsys
              .writeJson(file, { ...rawAuth, [norm]: effective.auth }, 0o600)
              .pipe(Effect.mapError(fail("Failed to write auth data")))
          }
          yield* writePoolsIfPresent(pools, true)
          return
        }

        if (action === "removeAccount") {
          const accountId = meta.accountId?.trim()
          if (!accountId) return
          pool.accounts = pool.accounts.filter((a) => a.id !== accountId)
          clearAccountStatus(norm, accountId)
          if (pool.workspaceAccounts) {
            for (const [dirKey, val] of Object.entries(pool.workspaceAccounts)) {
              if (val === accountId) delete pool.workspaceAccounts[dirKey]
            }
          }
          for (const [sid, map] of sessionSelections.entries()) {
            if (map[norm] === accountId) setSessionAccountSelection(sid, norm, undefined)
          }

          if (pool.accounts.length === 0) {
            delete pools[norm]
            cachedPools.delete(norm)
            const nextAuth = { ...rawAuth }
            delete nextAuth[key]
            delete nextAuth[norm]
            if (!process.env.KILO_AUTH_CONTENT) {
              yield* fsys.writeJson(file, nextAuth, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
            }
            yield* writePoolsIfPresent(pools, true)
            return
          }

          if (!pool.accounts.some((a) => a.id === pool.activeAccountId)) {
            pool.activeAccountId = pool.accounts[0]!.id
          }
          cachedPools.set(norm, pool)
          const effective = resolveEffectiveEntry(norm, pool) ?? pool.accounts[0]!
          if (!process.env.KILO_AUTH_CONTENT) {
            yield* fsys
              .writeJson(file, { ...rawAuth, [norm]: effective.auth }, 0o600)
              .pipe(Effect.mapError(fail("Failed to write auth data")))
          }
          yield* writePoolsIfPresent(pools, true)
          return
        }

        if (action === "updateAccount") {
          const accountId = meta.accountId?.trim()
          const label = meta.label?.trim()
          const direction = meta.direction?.trim()
          if (accountId && label) {
            const target = pool.accounts.find((a) => a.id === accountId)
            if (target) {
              target.label = label
              target.updatedAt = Date.now()
            }
          }
          if (accountId && (direction === "up" || direction === "down")) {
            const idx = pool.accounts.findIndex((a) => a.id === accountId)
            const swapIdx = direction === "up" ? idx - 1 : idx + 1
            if (idx >= 0 && swapIdx >= 0 && swapIdx < pool.accounts.length) {
              const copy = [...pool.accounts]
              const temp = copy[idx]!
              copy[idx] = copy[swapIdx]!
              copy[swapIdx] = temp
              pool.accounts = copy
            }
          }
          cachedPools.set(norm, pool)
          yield* writePoolsIfPresent(pools, true)
          return
        }

        if (action === "setFallback") {
          pool.autoFallback = meta.autoFallback !== "false"
          cachedPools.set(norm, pool)
          yield* writePoolsIfPresent(pools, true)
          return
        }

        if (action === "clearCooldown") {
          clearAccountStatus(norm, meta.accountId?.trim() || undefined)
          return
        }
        return
      }

      // Standard credential set or add/edit account
      const now = Date.now()
      const existingPool = pools[norm]
      const hasMultiDirectives = Boolean(
        directives.accountId || directives.accountLabel || directives.accountMode,
      )

      if (existingPool && (hasMultiDirectives || existingPool.accounts.length > 1)) {
        const mode = directives.accountMode
        if (mode === "add") {
          const newId = directives.accountId || generateAccountId()
          const label = directives.accountLabel || `Account ${existingPool.accounts.length + 1}`
          existingPool.accounts.push({
            id: newId,
            label,
            auth: directives.clean,
            createdAt: now,
            updatedAt: now,
          })
          existingPool.activeAccountId = newId
          clearAccountStatus(norm, newId)
        } else if (mode === "edit" && directives.accountId) {
          const target = existingPool.accounts.find((a) => a.id === directives.accountId)
          if (target) {
            const keepKey =
              directives.clean.type === "api" &&
              directives.clean.key === KEEP_EXISTING_KEY_SENTINEL &&
              target.auth.type === "api"
            const nextAuth = keepKey
              ? new Api({
                  type: "api",
                  key: (target.auth as Api).key,
                  ...(directives.clean.metadata ? { metadata: directives.clean.metadata } : {}),
                })
              : directives.clean
            target.auth = nextAuth
            if (directives.accountLabel) target.label = directives.accountLabel
            target.updatedAt = now
            clearAccountStatus(norm, target.id)
          } else {
            existingPool.accounts.push({
              id: directives.accountId,
              label: directives.accountLabel || `Account ${existingPool.accounts.length + 1}`,
              auth: directives.clean,
              createdAt: now,
              updatedAt: now,
            })
            existingPool.activeAccountId = directives.accountId
          }
        } else {
          const targetId = directives.accountId ?? existingPool.activeAccountId
          const target = existingPool.accounts.find((a) => a.id === targetId) ?? existingPool.accounts[0]
          if (target) {
            target.auth = directives.clean
            if (directives.accountLabel) target.label = directives.accountLabel
            target.updatedAt = now
            clearAccountStatus(norm, target.id)
          }
        }
        cachedPools.set(norm, existingPool)
        const effective = resolveEffectiveEntry(norm, existingPool)
        const nextData = { ...rawAuth }
        if (norm !== key) delete nextData[key]
        delete nextData[norm + "/"]
        nextData[norm] = effective?.auth ?? directives.clean
        if (!process.env.KILO_AUTH_CONTENT) {
          yield* fsys.writeJson(file, nextData, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
        }
        yield* writePoolsIfPresent(pools, true)
        return
      }

      // First account or single-account update
      const initialId = directives.accountId || "default"
      const initialLabel = directives.accountLabel || "Account 1"
      const newPool: ProviderAccountPool = {
        accounts: [
          {
            id: initialId,
            label: initialLabel,
            auth: directives.clean,
            createdAt: now,
            updatedAt: now,
          },
        ],
        activeAccountId: initialId,
        autoFallback: true,
      }
      pools[norm] = newPool
      cachedPools.set(norm, newPool)
      clearAccountStatus(norm)

      const data = { ...rawAuth }
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      if (!process.env.KILO_AUTH_CONTENT) {
        yield* fsys
          .writeJson(file, { ...data, [norm]: directives.clean }, 0o600)
          .pipe(Effect.mapError(fail("Failed to write auth data")))
      }
      yield* writePoolsIfPresent(pools, hasMultiDirectives)
      // kilocode_change end
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      // kilocode_change start
      const { rawAuth, pools } = yield* resolvePools()
      const data = { ...rawAuth }
      delete data[key]
      delete data[norm]
      delete pools[key]
      delete pools[norm]
      cachedPools.delete(key)
      cachedPools.delete(norm)
      clearAccountStatus(norm)
      if (!process.env.KILO_AUTH_CONTENT) {
        yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
      }
      yield* writePoolsIfPresent(pools, false)

      if (key === "kilo") {
        yield* Effect.promise(() => Telemetry.updateIdentity(null))
      }
      Telemetry.trackAuthLogout(key)
      // kilocode_change end
    })

    return Service.of({ get, all, set, remove, summaries }) // kilocode_change
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })
export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer)) // kilocode_change - legacy Kilo runtime compatibility

export * as Auth from "."
