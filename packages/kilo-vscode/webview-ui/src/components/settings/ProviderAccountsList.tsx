import { Component, For, Show, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Tag } from "@kilocode/kilo-ui/tag"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { createProviderAction } from "../../utils/provider-action"
import type { ProviderAccountInfo, ProviderAccountSummary } from "../../types/messages"
import ProviderConnectDialog from "./ProviderConnectDialog"

interface ProviderAccountsListProps {
  providerID: string
  summary: ProviderAccountSummary
  canManage: boolean
}

const ProviderAccountsList: Component<ProviderAccountsListProps> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const vscode = useVSCode()
  const action = createProviderAction(vscode)

  onCleanup(action.dispose)

  const multi = () => props.summary.accounts.length > 1

  function selectAccount(accountId: string) {
    action.send(
      {
        type: "manageProviderAccount",
        providerID: props.providerID,
        action: "select",
        accountId,
        scope: "workspace",
      },
      {},
    )
  }

  function removeAccount(accountId: string) {
    action.send(
      {
        type: "manageProviderAccount",
        providerID: props.providerID,
        action: "removeAccount",
        accountId,
      },
      {},
    )
  }

  function moveAccount(accountId: string, direction: "up" | "down") {
    action.send(
      {
        type: "manageProviderAccount",
        providerID: props.providerID,
        action: "updateAccount",
        accountId,
        direction,
      },
      {},
    )
  }

  function toggleAutoFallback(checked: boolean) {
    action.send(
      {
        type: "manageProviderAccount",
        providerID: props.providerID,
        action: "setFallback",
        autoFallback: checked,
      },
      {},
    )
  }

  function addAccount() {
    dialog.show(() => <ProviderConnectDialog providerID={props.providerID} accountMode="add" />)
  }

  function editAccount(acc: ProviderAccountInfo) {
    dialog.show(() => (
      <ProviderConnectDialog
        providerID={props.providerID}
        accountMode="edit"
        accountId={acc.id}
        initialLabel={acc.label}
      />
    ))
  }

  function statusLabel(acc: ProviderAccountInfo) {
    if (acc.status === "cooldown") return language.t("settings.providers.accounts.status.cooldown")
    if (acc.status === "error") return language.t("settings.providers.accounts.status.error")
    if (acc.id === props.summary.activeAccountId) return language.t("settings.providers.accounts.status.active")
    return ""
  }

  return (
    <Show when={props.canManage && props.summary.accounts.length > 0}>
      <div
        data-component="provider-accounts-list"
        style={{
          width: "100%",
          display: "flex",
          "flex-direction": "column",
          gap: "8px",
          "padding-left": "32px",
          "padding-top": "4px",
        }}
      >
        <div
          style={{
            display: "flex",
            "flex-wrap": "wrap",
            "align-items": "center",
            "justify-content": "space-between",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <Show when={multi()}>
              <Tag>{language.t("settings.providers.accounts.count", { count: props.summary.accounts.length })}</Tag>
              <Tooltip value={language.t("settings.providers.accounts.autoFallback.tooltip")} placement="top">
                <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                  <Switch
                    checked={props.summary.autoFallback}
                    onChange={(checked) => toggleAutoFallback(checked)}
                    hideLabel
                  >
                    {language.t("settings.providers.accounts.autoFallback")}
                  </Switch>
                  <span
                    style={{
                      "font-size": "var(--kilo-font-size-12)",
                      color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                    }}
                  >
                    {language.t("settings.providers.accounts.autoFallback")}
                  </span>
                </div>
              </Tooltip>
            </Show>
          </div>
          <Button size="small" variant="secondary" icon="plus-small" onClick={addAccount}>
            {language.t("settings.providers.accounts.add")}
          </Button>
        </div>

        <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
          <For each={props.summary.accounts}>
            {(acc, index) => {
              const active = () => acc.id === props.summary.activeAccountId
              const status = () => statusLabel(acc)
              return (
                <div
                  data-slot="provider-account-row"
                  data-active={active() ? "" : undefined}
                  style={{
                    display: "flex",
                    "flex-wrap": "wrap",
                    "align-items": "center",
                    "justify-content": "space-between",
                    gap: "8px",
                    padding: "6px 8px",
                    "border-radius": "6px",
                    background: active()
                      ? "color-mix(in srgb, var(--vscode-button-background, #007acc) 10%, transparent)"
                      : "var(--surface-inset-base, rgba(128,128,128,0.06))",
                    border: active()
                      ? "1px solid color-mix(in srgb, var(--vscode-button-background, #007acc) 35%, transparent)"
                      : "1px solid var(--border-weak-base)",
                  }}
                >
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", "min-width": 0 }}>
                    <span
                      style={{
                        "font-size": "var(--kilo-font-size-11)",
                        color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                        "font-variant-numeric": "tabular-nums",
                      }}
                    >
                      #{index() + 1}
                    </span>
                    <span
                      style={{
                        "font-size": "var(--kilo-font-size-13)",
                        "font-weight": active() ? "600" : "400",
                        color: "var(--vscode-foreground)",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                      }}
                    >
                      {acc.label}
                    </span>
                    <span
                      style={{
                        "font-size": "var(--kilo-font-size-12)",
                        "font-family": "var(--vscode-editor-font-family, monospace)",
                        color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                      }}
                    >
                      {acc.maskedHint}
                    </span>
                    <Show when={status()}>
                      <Tooltip value={acc.lastError || status()} placement="top">
                        <Tag>{status()}</Tag>
                      </Tooltip>
                    </Show>
                  </div>

                  <div style={{ display: "flex", "align-items": "center", gap: "2px" }}>
                    <Show when={!active()}>
                      <Tooltip value={language.t("settings.providers.accounts.action.activate")} placement="top">
                        <IconButton
                          icon="check-small"
                          size="small"
                          variant="ghost"
                          aria-label={language.t("settings.providers.accounts.action.activate")}
                          onClick={() => selectAccount(acc.id)}
                        />
                      </Tooltip>
                    </Show>
                    <Tooltip value={language.t("settings.providers.accounts.action.edit")} placement="top">
                      <IconButton
                        icon="edit-small-2"
                        size="small"
                        variant="ghost"
                        aria-label={language.t("settings.providers.accounts.action.edit")}
                        onClick={() => editAccount(acc)}
                      />
                    </Tooltip>
                    <Show when={multi()}>
                      <Tooltip value={language.t("settings.providers.accounts.action.moveUp")} placement="top">
                        <IconButton
                          icon="arrow-up"
                          size="small"
                          variant="ghost"
                          disabled={index() === 0}
                          aria-label={language.t("settings.providers.accounts.action.moveUp")}
                          onClick={() => moveAccount(acc.id, "up")}
                        />
                      </Tooltip>
                      <Tooltip value={language.t("settings.providers.accounts.action.moveDown")} placement="top">
                        <IconButton
                          icon="chevron-down"
                          size="small"
                          variant="ghost"
                          disabled={index() === props.summary.accounts.length - 1}
                          aria-label={language.t("settings.providers.accounts.action.moveDown")}
                          onClick={() => moveAccount(acc.id, "down")}
                        />
                      </Tooltip>
                      <Tooltip value={language.t("settings.providers.accounts.action.remove")} placement="top">
                        <IconButton
                          icon="close-small"
                          size="small"
                          variant="ghost"
                          aria-label={language.t("settings.providers.accounts.action.remove")}
                          onClick={() => removeAccount(acc.id)}
                        />
                      </Tooltip>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </div>
    </Show>
  )
}

export default ProviderAccountsList
