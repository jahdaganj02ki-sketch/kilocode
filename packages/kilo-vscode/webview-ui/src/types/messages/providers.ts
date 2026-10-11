// Provider/model types for model selector

export interface ProviderModel {
  id: string
  name: string
  inputPrice?: number
  outputPrice?: number
  contextLength?: number
  releaseDate?: string
  latest?: boolean
  // Actual shape returned by the server (Provider.Model)
  limit?: { context: number; input?: number; output: number }
  variants?: Record<string, Record<string, unknown>>
  capabilities?: {
    reasoning: boolean
    input?: { text: boolean; image: boolean; audio: boolean; video: boolean; pdf: boolean }
  }
  options?: { description?: string }
  autoRouting?: { models: string[] }
  recommendedIndex?: number
  isFree?: boolean
  mayTrainOnYourPrompts?: boolean
  hasUserByokAvailable?: boolean
  terminalBench?: {
    overallScore: number
    avgAttemptCostUsd: number
  }
  cost?: {
    input: number
    output: number
    cache?: {
      read: number
      write: number
    }
  }
}

export interface Provider {
  id: string
  name: string
  models: Record<string, ProviderModel>
  source?: "env" | "config" | "custom" | "api"
  env?: string[]
  metadata?: {
    noteKey?: string
    icon?: string
    priority?: number
  }
}

export interface ModelSelection {
  providerID: string
  modelID: string
}

export interface ModelUsage {
  count: number
  lastUsed: number
}

export type ModelUsageMap = Record<string, ModelUsage>

export type ProviderAuthState = "api" | "oauth" | "wellknown"

export type ProviderAccountStatus = "active" | "standby" | "cooldown" | "error"

export interface ProviderAccountInfo {
  id: string
  label: string
  type: ProviderAuthState
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

export interface ProviderConfig {
  name?: string
  api_key?: string
  base_url?: string
  models?: Record<string, unknown>
  npm?: string
  env?: string[]
  options?: Record<string, unknown>
}
