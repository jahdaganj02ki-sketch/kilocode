// kilocode_change - new file
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { SessionRetry } from "../../src/session/retry"
import { SessionV1 } from "@opencode-ai/core/v1/session"

function runAuth<A>(effect: Effect.Effect<A, Auth.AuthError, Auth.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(Auth.defaultLayer)))
}

describe("Multi-account provider authentication & auto-fallback", () => {
  beforeEach(() => {
    Auth.resetRuntimeAccountStateForTests()
    process.env.KILO_AUTH_CONTENT = JSON.stringify({
      openai: { type: "api", key: "sk-proj-first1111" },
    })
  })

  test("synthesizes initial account pool from existing single-key auth and masks hints safely", async () => {
    const summaries = await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        return yield* svc.summaries!()
      }),
    )

    expect(summaries.openai).toBeDefined()
    expect(summaries.openai.accounts).toHaveLength(1)
    expect(summaries.openai.accounts[0]?.label).toBe("Account 1")
    expect(summaries.openai.accounts[0]?.maskedHint).toBe("sk-…1111")
    expect(summaries.openai.accounts[0]?.status).toBe("active")
    expect(summaries.openai.autoFallback).toBe(true)
  })

  test("adds multiple accounts, switches active account per global/workspace/session, reorders, and removes", async () => {
    await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        yield* svc.set("openai", {
          type: "api",
          key: "sk-proj-second2222",
          metadata: {
            __accountId: "acc_work",
            __accountLabel: "Arbeit",
            __accountMode: "add",
          },
        })
        yield* svc.set("openai", {
          type: "api",
          key: "sk-proj-third3333",
          metadata: {
            __accountId: "acc_priv",
            __accountLabel: "Privat",
            __accountMode: "add",
          },
        })
      }),
    )

    let summaries = await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        return yield* svc.summaries!()
      }),
    )
    expect(summaries.openai.accounts.map((a) => a.label)).toEqual(["Account 1", "Arbeit", "Privat"])
    expect(summaries.openai.effectiveAccountId).toBe("acc_priv")

    // Select "Arbeit" for workspace "/repo/work" and "Account 1" for session "sess_1"
    await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        yield* svc.set("openai", {
          type: "api",
          key: Auth.ACCOUNT_ACTION_SENTINEL,
          metadata: {
            __accountAction: "select",
            accountId: "acc_work",
            scope: "workspace",
            directory: "/repo/work",
          },
        })
        yield* svc.set("openai", {
          type: "api",
          key: Auth.ACCOUNT_ACTION_SENTINEL,
          metadata: {
            __accountAction: "select",
            accountId: "default",
            scope: "session",
            sessionID: "sess_1",
          },
        })
      }),
    )

    const wsSummaries = await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        return yield* svc.summaries!({ directory: "/repo/work" })
      }),
    )
    expect(wsSummaries.openai.effectiveAccountId).toBe("acc_work")

    const sessSummaries = await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        return yield* svc.summaries!({ directory: "/repo/work", sessionID: "sess_1" })
      }),
    )
    expect(sessSummaries.openai.effectiveAccountId).toBe("default")

    // Reorder "Privat" up and rename it
    await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        yield* svc.set("openai", {
          type: "api",
          key: Auth.ACCOUNT_ACTION_SENTINEL,
          metadata: {
            __accountAction: "updateAccount",
            accountId: "acc_priv",
            label: "Privat Pro",
            direction: "up",
          },
        })
      }),
    )

    summaries = await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        return yield* svc.summaries!()
      }),
    )
    expect(summaries.openai.accounts.map((a) => a.label)).toEqual(["Account 1", "Privat Pro", "Arbeit"])

    // Remove "acc_priv"
    await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        yield* svc.set("openai", {
          type: "api",
          key: Auth.ACCOUNT_ACTION_SENTINEL,
          metadata: {
            __accountAction: "removeAccount",
            accountId: "acc_priv",
          },
        })
      }),
    )

    summaries = await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        return yield* svc.summaries!()
      }),
    )
    expect(summaries.openai.accounts.map((a) => a.id)).toEqual(["default", "acc_work"])
    expect(summaries.openai.activeAccountId).toBe("default")
  })

  test("automatically rotates to next non-cooldown account on 429 rate-limit error when autoFallback is enabled", async () => {
    await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        yield* svc.set("openai", {
          type: "api",
          key: "sk-proj-backup9999",
          metadata: {
            __accountId: "acc_backup",
            __accountLabel: "Backup Key",
            __accountMode: "add",
          },
        })
        // Set "default" as active first
        yield* svc.set("openai", {
          type: "api",
          key: Auth.ACCOUNT_ACTION_SENTINEL,
          metadata: {
            __accountAction: "select",
            accountId: "default",
            scope: "global",
          },
        })
      }),
    )

    const initial = await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        return yield* svc.get("openai")
      }),
    )
    expect(initial?.type === "api" && initial.key).toBe("sk-proj-first1111")

    // Simulate a 429 rate limit error
    const err = new SessionV1.APIError({
      message: "Rate limit reached for requests",
      statusCode: 429,
      isRetryable: false,
    }).toObject()
    expect(SessionRetry.isRateLimitOrQuotaError(err)).toBe(true)
    expect(SessionRetry.retryable(err, "openai")).toBeDefined()

    const rotation = Auth.rotateAccountInMemory({
      providerID: "openai",
      cooldownMs: 60_000,
      message: "Rate limit reached for requests",
    })
    expect(rotation.rotated).toBe(true)
    expect(rotation.nextAccount?.id).toBe("acc_backup")
    expect(rotation.nextAccount?.label).toBe("Backup Key")

    const afterFallback = await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        return yield* svc.get("openai")
      }),
    )
    expect(afterFallback?.type === "api" && afterFallback.key).toBe("sk-proj-backup9999")

    const summaries = await runAuth(
      Effect.gen(function* () {
        const svc = yield* Auth.Service
        return yield* svc.summaries!()
      }),
    )
    const defaultStatus = summaries.openai.accounts.find((a) => a.id === "default")
    const backupStatus = summaries.openai.accounts.find((a) => a.id === "acc_backup")
    expect(defaultStatus?.status).toBe("cooldown")
    expect(defaultStatus?.lastError).toBe("Rate limit reached for requests")
    expect(backupStatus?.status).toBe("active")
  })
})
