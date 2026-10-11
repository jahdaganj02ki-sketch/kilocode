import { type Accessor, Component, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { PopupSelector } from "./PopupSelector"
import { Button } from "@kilocode/kilo-ui/button"
import { Tag } from "@kilocode/kilo-ui/tag"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useSession } from "../../context/session"
import { useProvider } from "../../context/provider"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { createProviderAction } from "../../utils/provider-action"
import type { ProviderAccountInfo } from "../../types/messages"
import ProviderConnectDialog from "../settings/ProviderConnectDialog"

export interface AccountSelectorProps {
  sessionID?: Accessor<string | undefined>
  blocked?: boolean
}

export const AccountSelector: Component<AccountSelectorProps> = (props) => {
  const session = useSession()
  const provider = useProvider()
  const language = useLanguage()
  const vscode = useVSCode()
  const dialog = useDialog()
  const action = createProviderAction(vscode)
  const [open, setOpen] = createSignal(false)

  onCleanup(action.dispose)

  const id = () => props.sessionID?.()
  const providerID = createMemo(() => session.selected(id())?.providerID)
  const summary = createMemo(() => {
    const pid = providerID()
    if (!pid) return undefined
    return provider.providerAccounts()[pid]
  })
  const accounts = createMemo(() => summary()?.accounts ?? [])
  const activeAccount = createMemo(
    () => accounts().find((acc) => acc.id === summary()?.activeAccountId) ?? accounts()[0],
  )

  function statusLabel(acc: ProviderAccountInfo) {
    if (acc.status === "cooldown") return language.t("settings.providers.accounts.status.cooldown")
    if (acc.status === "error") return language.t("settings.providers.accounts.status.error")
    if (acc.id === summary()?.activeAccountId) return language.t("settings.providers.accounts.status.active")
    return ""
  }

  function pickAccount(accountId: string) {
    const pid = providerID()
    if (!pid) return
    const sid = id()
    action.send(
      {
        type: "manageProviderAccount",
        providerID: pid,
        action: "select",
        accountId,
        scope: sid ? "session" : "workspace",
        sessionID: sid,
      },
      {},
    )
    setOpen(false)
  }

  function openAddAccount() {
    const pid = providerID()
    if (!pid) return
    setOpen(false)
    dialog.show(() => <ProviderConnectDialog providerID={pid} accountMode="add" />)
  }

  return (
    <Show when={accounts().length > 1}>
      <Tooltip
        value={`${language.t("prompt.account.tooltip")}: ${activeAccount()?.label ?? ""}`}
        placement="top"
        openDelay={0}
      >
        <PopupSelector
          expanded={false}
          placement="top-start"
          preferredWidth={240}
          minHeight={100}
          open={open()}
          onOpenChange={(val) => {
            if (val && props.blocked) return
            setOpen(val)
          }}
          triggerAs={Button}
          triggerProps={{
            variant: "ghost",
            size: "small",
            "aria-label": language.t("prompt.account.tooltip"),
            disabled: props.blocked,
          }}
          trigger={
            <>
              <Show when={activeAccount()?.label} keyed>
                {(label) => <span class="account-selector-trigger-label">{label}</span>}
              </Show>
              <svg
                class="selector-trigger-chevron"
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="currentColor"
                style={{ "flex-shrink": "0" }}
              >
                <path d="M8 4l4 5H4l4-5z" />
              </svg>
            </>
          }
        >
          {(bodyH) => (
            <div
              class="thinking-selector-list"
              role="listbox"
              aria-label={language.t("prompt.account.tooltip")}
              style={bodyH() !== undefined ? { "max-height": `${bodyH()}px` } : {}}
            >
              <div class="thinking-selector-heading" aria-hidden="true">
                {language.t("prompt.account.tooltip")}
              </div>
              <For each={accounts()}>
                {(acc, index) => {
                  const selected = () => acc.id === activeAccount()?.id
                  const status = () => statusLabel(acc)
                  return (
                    <div
                      class={`thinking-selector-item${selected() ? " selected" : ""}`}
                      role="option"
                      aria-selected={selected()}
                      tabindex={0}
                      onClick={() => pickAccount(acc.id)}
                      style={{
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "space-between",
                        gap: "8px",
                      }}
                    >
                      <div style={{ display: "flex", "align-items": "center", gap: "6px", "min-width": 0 }}>
                        <span
                          style={{
                            "font-size": "var(--kilo-font-size-11)",
                            color: "var(--text-weak, var(--vscode-descriptionForeground))",
                            "font-variant-numeric": "tabular-nums",
                          }}
                        >
                          #{index() + 1}
                        </span>
                        <span
                          class="thinking-selector-item-name"
                          style={{
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                            "font-weight": selected() ? "600" : "400",
                          }}
                        >
                          {acc.label}
                        </span>
                        <span
                          style={{
                            "font-size": "var(--kilo-font-size-11)",
                            "font-family": "var(--vscode-editor-font-family, monospace)",
                            color: "var(--text-weak, var(--vscode-descriptionForeground))",
                          }}
                        >
                          {acc.maskedHint}
                        </span>
                      </div>
                      <Show when={status()}>
                        <Tag>{status()}</Tag>
                      </Show>
                    </div>
                  )
                }}
              </For>
              <div
                class="thinking-selector-item"
                role="option"
                aria-selected={false}
                tabindex={0}
                onClick={openAddAccount}
                style={{
                  "border-top": "1px solid var(--border-weak-base)",
                  color: "var(--text-weak, var(--vscode-descriptionForeground))",
                }}
              >
                + {language.t("prompt.account.add")}
              </div>
            </div>
          )}
        </PopupSelector>
      </Tooltip>
    </Show>
  )
}
