import { describe, expect, it } from "bun:test"
import {
  ACCOUNT_ACTION_SENTINEL,
  buildAccountDirectivesMetadata,
  buildManageAccountAuthPayload,
  buildOAuthAccountInputs,
  extractBackendAccountSummary,
  synthesizeFallbackAccountSummary,
} from "../../src/shared/provider-accounts"
import { authorizeProviderOAuth, connectProvider, manageProviderAccount } from "../../src/provider-actions"
import { createProviderAction } from "../../webview-ui/src/utils/provider-action"
import type { ExtensionMessage, WebviewMessage } from "../../webview-ui/src/types/messages"

describe("provider-accounts shared helpers", () => {
  it("extracts backend account summary from provider options.__kiloAccounts", () => {
    const result = extractBackendAccountSummary("openai", {
      baseURL: "https://api.openai.com/v1",
      __kiloAccounts: {
        providerID: "openai",
        activeAccountId: "acc-2",
        effectiveAccountId: "acc-2",
        autoFallback: false,
        accounts: [
          {
            id: "acc-1",
            label: "Privat",
            type: "api",
            maskedHint: "sk-p…1111",
            priority: 0,
            active: false,
            status: "cooldown",
            cooldownUntil: 1700000060000,
            lastError: "429 Too Many Requests",
          },
          {
            id: "acc-2",
            label: "Arbeit",
            type: "oauth",
            maskedHint: "OAuth (acct-work)",
            priority: 1,
            active: true,
            status: "active",
          },
        ],
      },
    })

    expect(result).toEqual({
      cleanedOptions: { baseURL: "https://api.openai.com/v1" },
      summary: {
        providerID: "openai",
        activeAccountId: "acc-2",
        effectiveAccountId: "acc-2",
        autoFallback: false,
        accounts: [
          {
            id: "acc-1",
            label: "Privat",
            type: "api",
            maskedHint: "sk-p…1111",
            priority: 0,
            active: false,
            status: "cooldown",
            cooldownUntil: 1700000060000,
            lastError: "429 Too Many Requests",
          },
          {
            id: "acc-2",
            label: "Arbeit",
            type: "oauth",
            maskedHint: "OAuth (acct-work)",
            priority: 1,
            active: true,
            status: "active",
          },
        ],
      },
    })
  })

  it("synthesizes a fallback summary when backend options do not include __kiloAccounts", () => {
    const summary = synthesizeFallbackAccountSummary("anthropic", "api")
    expect(summary.providerID).toBe("anthropic")
    expect(summary.activeAccountId).toBe("default")
    expect(summary.autoFallback).toBe(true)
    expect(summary.accounts).toHaveLength(1)
    expect(summary.accounts[0]?.maskedHint).toBe("API Key")
  })

  it("builds account directive metadata and manage payloads", () => {
    expect(
      buildAccountDirectivesMetadata(
        { region: "eu-central-1" },
        { accountId: "acc-1", accountLabel: "Produktion", accountMode: "add" },
      ),
    ).toEqual({
      region: "eu-central-1",
      __accountId: "acc-1",
      __accountLabel: "Produktion",
      __accountMode: "add",
    })

    expect(
      buildOAuthAccountInputs(
        { resourceName: "corp" },
        { accountId: "acc-2", accountLabel: "OAuth Team", accountMode: "edit" },
      ),
    ).toEqual({
      resourceName: "corp",
      __accountId: "acc-2",
      __accountLabel: "OAuth Team",
      __accountMode: "edit",
    })

    expect(
      buildManageAccountAuthPayload({
        action: "select",
        accountId: "acc-2",
        scope: "session",
        sessionID: "sess-99",
      }),
    ).toEqual({
      type: "api",
      key: ACCOUNT_ACTION_SENTINEL,
      metadata: {
        __accountAction: "select",
        accountId: "acc-2",
        scope: "session",
        sessionID: "sess-99",
      },
    })
  })
})

describe("provider-actions multi-account operations", () => {
  it("forwards account directives on connectProvider, authorizeProviderOAuth, and manageProviderAccount", async () => {
    const authSets: Array<{ providerID: string; auth: unknown }> = []
    const oauthCalls: Array<unknown> = []
    const posts: unknown[] = []
    let refreshed = 0

    const ctx = {
      client: {
        auth: {
          set: async (input: { providerID: string; auth: unknown }) => {
            authSets.push(input)
            return { data: true }
          },
        },
        provider: {
          oauth: {
            authorize: async (input: unknown) => {
              oauthCalls.push(input)
              return { data: { url: "https://auth.example.com", method: "auto", instructions: "" } }
            },
          },
        },
      },
      postMessage: (message: unknown) => posts.push(message),
      getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
      workspaceDir: "/tmp/ws",
      disposeGlobal: async () => {},
      fetchAndSendProviders: async () => {
        refreshed += 1
      },
    }

    await connectProvider(ctx as never, "req-add", "openai", "sk-new-key-1234", undefined, {
      accountLabel: "Team Key",
      accountMode: "add",
    })
    expect(authSets[0]).toEqual({
      providerID: "openai",
      auth: {
        type: "api",
        key: "sk-new-key-1234",
        metadata: {
          __accountLabel: "Team Key",
          __accountMode: "add",
        },
      },
    })

    await authorizeProviderOAuth(ctx as never, "req-oauth", "openai", 0, undefined, {
      accountLabel: "ChatGPT Plus",
      accountMode: "add",
    })
    expect(oauthCalls[0]).toEqual({
      providerID: "openai",
      method: 0,
      directory: "/tmp/ws",
      inputs: {
        __accountLabel: "ChatGPT Plus",
        __accountMode: "add",
      },
    })

    await manageProviderAccount(ctx as never, "req-manage", "openai", {
      action: "setFallback",
      autoFallback: false,
    })
    expect(authSets[1]).toEqual({
      providerID: "openai",
      auth: {
        type: "api",
        key: ACCOUNT_ACTION_SENTINEL,
        metadata: {
          __accountAction: "setFallback",
          autoFallback: "false",
          directory: "/tmp/ws",
        },
      },
    })
    expect(refreshed).toBe(2)
  })

  it("supports manageProviderAccount in createProviderAction", () => {
    const sent: WebviewMessage[] = []
    let handler: ((message: ExtensionMessage) => void) | undefined
    const action = createProviderAction({
      postMessage(msg) {
        sent.push(msg)
      },
      onMessage(next) {
        handler = next
        return () => {
          handler = undefined
        }
      },
    })

    const completed: string[] = []
    const reqId = action.send(
      {
        type: "manageProviderAccount",
        providerID: "openai",
        action: "select",
        accountId: "acc-2",
        scope: "session",
        sessionID: "sess-1",
      },
      {
        onConnected: (m) => completed.push(m.providerID),
      },
    )

    expect(sent[0]).toMatchObject({
      type: "manageProviderAccount",
      requestId: reqId,
      providerID: "openai",
      action: "select",
      accountId: "acc-2",
      scope: "session",
      sessionID: "sess-1",
    })

    handler?.({
      type: "providerConnected",
      requestId: reqId,
      providerID: "openai",
    })
    expect(completed).toEqual(["openai"])
    action.dispose()
  })
})
