export type ProviderAccountStatus = "active" | "standby" | "cooldown" | "error"

export interface ProviderAccountInfo {
  id: string
  label: string
  type: "api" | "oauth" | "wellknown"
  maskedHint: string
  status: ProviderAccountStatus
  active: boolean
  priority: number
  cooldownUntil?: number
  lastError?: string
  metadata?: Record<string, string>
}

export interface ProviderAccountSummary {
  providerID: string
  activeAccountId: string
  workspaceAccountId?: string
  sessionAccountId?: string
  effectiveAccountId: string
  autoFallback: boolean
  accounts: ProviderAccountInfo[]
}

export interface AccountMutationOptions {
  accountId?: string
  accountLabel?: string
  accountMode?: "add" | "edit" | "replace"
}

export interface ManageAccountActionInput {
  action: "select" | "removeAccount" | "updateAccount" | "setFallback" | "clearCooldown"
  accountId?: string
  label?: string
  direction?: "up" | "down"
  scope?: "global" | "workspace" | "session"
  sessionID?: string
  directory?: string
  autoFallback?: boolean
}

export const ACCOUNT_ACTION_SENTINEL = "__kilo_account_action__"
export const KEEP_EXISTING_KEY_SENTINEL = "__keep_existing_key__"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseAccountStatus(raw: Record<string, unknown>): ProviderAccountStatus {
  if (raw.status === "cooldown" || raw.status === "error" || raw.status === "standby" || raw.status === "active") {
    return raw.status
  }
  return raw.active === true ? "active" : "standby"
}

function parseAccountMetadata(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && !entry[0].startsWith("__account"),
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function parseAccountInfo(raw: unknown, index: number): ProviderAccountInfo | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === "string" && raw.id ? raw.id : `acc_${index + 1}`
  const label = typeof raw.label === "string" && raw.label ? raw.label : `Account ${index + 1}`
  const type = raw.type === "oauth" || raw.type === "wellknown" ? raw.type : "api"
  const maskedHint = typeof raw.maskedHint === "string" ? raw.maskedHint : type === "oauth" ? "OAuth" : "API Key"
  const status = parseAccountStatus(raw)
  const metadata = parseAccountMetadata(raw.metadata)

  return {
    id,
    label,
    type,
    maskedHint,
    status,
    active: raw.active === true,
    priority: typeof raw.priority === "number" ? raw.priority : index + 1,
    ...(typeof raw.cooldownUntil === "number" ? { cooldownUntil: raw.cooldownUntil } : {}),
    ...(typeof raw.lastError === "string" && raw.lastError ? { lastError: raw.lastError } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

export function extractBackendAccountSummary(
  providerID: string,
  options: Record<string, unknown> | undefined,
): { summary?: ProviderAccountSummary; cleanedOptions?: Record<string, unknown> } {
  if (!options || !("__kiloAccounts" in options)) {
    return { cleanedOptions: options }
  }
  const rawSummary = options.__kiloAccounts
  const cleanedOptions = { ...options }
  delete cleanedOptions.__kiloAccounts

  if (!isRecord(rawSummary) || !Array.isArray(rawSummary.accounts)) {
    return { cleanedOptions }
  }

  const accounts = rawSummary.accounts
    .map((item, idx) => parseAccountInfo(item, idx))
    .filter((item): item is ProviderAccountInfo => item !== null)
  if (accounts.length === 0) {
    return { cleanedOptions }
  }

  const activeAccountId =
    typeof rawSummary.activeAccountId === "string" && rawSummary.activeAccountId
      ? rawSummary.activeAccountId
      : accounts[0]!.id
  const effectiveAccountId =
    typeof rawSummary.effectiveAccountId === "string" && rawSummary.effectiveAccountId
      ? rawSummary.effectiveAccountId
      : activeAccountId

  return {
    cleanedOptions,
    summary: {
      providerID,
      activeAccountId,
      ...(typeof rawSummary.workspaceAccountId === "string"
        ? { workspaceAccountId: rawSummary.workspaceAccountId }
        : {}),
      ...(typeof rawSummary.sessionAccountId === "string" ? { sessionAccountId: rawSummary.sessionAccountId } : {}),
      effectiveAccountId,
      autoFallback: rawSummary.autoFallback !== false,
      accounts,
    },
  }
}

export function synthesizeFallbackAccountSummary(
  providerID: string,
  authState: "api" | "oauth" | "wellknown" | undefined,
  source: string | undefined,
): ProviderAccountSummary | undefined {
  if (source === "env") return undefined
  const type = authState ?? (source === "custom" ? "oauth" : source === "api" || source === "config" ? "api" : undefined)
  if (!type) return undefined
  return {
    providerID,
    activeAccountId: "default",
    effectiveAccountId: "default",
    autoFallback: true,
    accounts: [
      {
        id: "default",
        label: "Account 1",
        type,
        maskedHint: type === "oauth" ? "OAuth" : "API Key",
        status: "active",
        active: true,
        priority: 1,
      },
    ],
  }
}

export function buildAccountDirectivesMetadata(
  metadata: Record<string, string> | undefined,
  account?: AccountMutationOptions,
): Record<string, string> | undefined {
  const id = account?.accountId?.trim()
  const label = account?.accountLabel?.trim()
  const mode = account?.accountMode
  if (!id && !label && !mode) return metadata

  return {
    ...(metadata ?? {}),
    ...(id ? { __accountId: id } : {}),
    ...(label ? { __accountLabel: label } : {}),
    ...(mode ? { __accountMode: mode } : {}),
  }
}

export function buildOAuthAccountInputs(
  inputs: Record<string, string> | undefined,
  account?: AccountMutationOptions,
): Record<string, string> | undefined {
  const id = account?.accountId?.trim()
  const label = account?.accountLabel?.trim()
  const mode = account?.accountMode
  if (!id && !label && !mode) return inputs

  return {
    ...(inputs ?? {}),
    ...(id ? { __accountId: id } : {}),
    ...(label ? { __accountLabel: label } : {}),
    ...(mode ? { __accountMode: mode } : {}),
  }
}

export function buildManageAccountAuthPayload(input: ManageAccountActionInput): {
  type: "api"
  key: string
  metadata: Record<string, string>
} {
  const metadata: Record<string, string> = {
    __accountAction: input.action,
  }
  if (input.accountId !== undefined) metadata.accountId = input.accountId
  if (input.label !== undefined) metadata.label = input.label
  if (input.direction !== undefined) metadata.direction = input.direction
  if (input.scope !== undefined) metadata.scope = input.scope
  if (input.sessionID !== undefined) metadata.sessionID = input.sessionID
  if (input.directory !== undefined) metadata.directory = input.directory
  if (input.autoFallback !== undefined) metadata.autoFallback = String(input.autoFallback)

  return {
    type: "api",
    key: ACCOUNT_ACTION_SENTINEL,
    metadata,
  }
}
