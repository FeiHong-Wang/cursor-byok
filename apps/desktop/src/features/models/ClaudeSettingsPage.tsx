import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, configuredPluginModels, type Model, type ModelInput } from "../../shared/api";
import { CursorModelCards, cursorModelGroups, type CursorModelGroup, type CursorModelGrouping } from "./CursorModelCards";
import { CursorModelEditor, emptyCursorModelDraft, type CursorModelDraft } from "./CursorModelEditor";
import styles from "./CursorSettings.module.scss";
import { PageContent } from "../../shell/layout/PageContent";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, SecretTextInput, TextInput } from "../../shared/ui/FormControls";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { Modal } from "../../shared/ui/Modal";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { addIcon, checkIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";
import type { CursorModelTestState } from "./CursorModelTestResult";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseObject(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // handled below
  }
  throw new Error(`${label} 必须是合法的 JSON 对象`);
}

function parseHeaders(text: string): Record<string, string> {
  const parsed = parseObject(text, "自定义 Headers");
  if (Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error("自定义 Headers 的值必须都是字符串");
  }
  return parsed as Record<string, string>;
}

function draftInput(draft: CursorModelDraft): ModelInput {
  const model = {
    ...draft.model,
    display_name: draft.model.display_name.trim(),
    base_url: draft.model.base_url.trim(),
    api_key: draft.model.api_key.trim(),
    tooltip_data: draft.model.tooltip_data.trim(),
    model_id: draft.model.model_id.trim(),
    openai_extra_params: parseObject(draft.openAIExtraParamsText, "OpenAI 额外参数"),
    custom_headers: parseHeaders(draft.customHeadersText),
    anthropic_extra_params: parseObject(draft.anthropicExtraParamsText, "Anthropic 额外参数"),
  };
  return model;
}

export function ClaudeSettingsPage() {
  const { models, ports, plugins } = useAppStore();
  const navigate = useNavigate();
  const message = useMessage();
  const [draft, setDraft] = useState<CursorModelDraft | null>(null);
  const [editing, setEditing] = useState<Model | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [deleting, setDeleting] = useState<Model | null>(null);
  const [testingModelHashes, setTestingModelHashes] = useState<Set<string>>(() => new Set());
  const [modelTestResults, setModelTestResults] = useState<Map<string, CursorModelTestState>>(() => new Map());
  const [savingAndTesting] = useState(false);
  const [batchTesting, setBatchTesting] = useState(false);
  const [grouping, setGrouping] = useState<CursorModelGrouping>("flat");
  const [settingsGroup, setSettingsGroup] = useState<CursorModelGroup | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [groupBaseUrlDraft, setGroupBaseUrlDraft] = useState("");
  const [groupApiKeyDraft, setGroupApiKeyDraft] = useState("");
  const [groupSettingsBusy, setGroupSettingsBusy] = useState(false);
  const [copiedBaseUrl, setCopiedBaseUrl] = useState(false);
  const activeModelTests = useRef(new Map<string, { testId: string; controller: AbortController; cancelling: boolean }>());

  const servicePort = ports?.service_port || 8080;
  const claudeBaseUrl = `http://127.0.0.1:${servicePort}`;

  const pluginModels = configuredPluginModels(plugins);
  const testTargets = [
    ...models.map((model) => ({ model_hash: model.model_hash, display_name: model.display_name })),
    ...pluginModels.map((model) => ({ model_hash: model.id, display_name: model.displayName })),
  ];
  const providerGroups = cursorModelGroups(models, "provider");
  const typeGroups = cursorModelGroups(models, "type");
  const canGroupByProvider = providerGroups.length > 1;
  const canGroupByType = typeGroups.length > 1;

  useEffect(() => {
    if ((grouping === "provider" && !canGroupByProvider) || (grouping === "type" && !canGroupByType)) {
      setGrouping("flat");
    }
  }, [canGroupByProvider, canGroupByType, grouping]);

  const copyEndpoint = useCallback(() => {
    void navigator.clipboard.writeText(claudeBaseUrl).then(() => {
      setCopiedBaseUrl(true);
      message(claudeBaseUrl);
      setTimeout(() => setCopiedBaseUrl(false), 2000);
    });
  }, [claudeBaseUrl, message]);

  const cancelModelTest = useCallback(async (modelHash: string) => {
    const active = activeModelTests.current.get(modelHash);
    if (!active || active.cancelling) return;
    active.cancelling = true;
    active.controller.abort();
    try {
      await api.cancelModelTest(modelHash, active.testId);
    } catch {
      // ignore
    }
  }, []);

  const testModel = useCallback(async (model: { model_hash: string; display_name: string }, notify = true) => {
    if (activeModelTests.current.has(model.model_hash)) {
      await cancelModelTest(model.model_hash);
      return;
    }
    const active = { testId: crypto.randomUUID(), controller: new AbortController(), cancelling: false };
    activeModelTests.current.set(model.model_hash, active);
    setTestingModelHashes((current: Set<string>) => new Set(current).add(model.model_hash));
    try {
      const result = await api.testModel(model.model_hash, active.testId, active.controller.signal);
      setModelTestResults((current: Map<string, CursorModelTestState>) => new Map(current).set(model.model_hash, { status: "success", result }));
      if (notify) message(`模型 ${model.display_name} 连通性测试成功 (${result.duration_ms} ms)`);
    } catch (cause) {
      if (active.cancelling || active.controller.signal.aborted) {
        setModelTestResults((current: Map<string, CursorModelTestState>) => new Map(current).set(model.model_hash, { status: "cancelled" }));
        return;
      }
      const error = errorText(cause);
      setModelTestResults((current: Map<string, CursorModelTestState>) => new Map(current).set(model.model_hash, { status: "error", error }));
      if (notify) message(`连通性测试失败: ${error}`);
    } finally {
      if (activeModelTests.current.get(model.model_hash) === active) activeModelTests.current.delete(model.model_hash);
      setTestingModelHashes((current: Set<string>) => {
        const next = new Set(current);
        next.delete(model.model_hash);
        return next;
      });
    }
  }, [cancelModelTest, message]);

  const testAll = useCallback(() => {
    if (batchTesting) return;
    setBatchTesting(true);
    testTargets.forEach((target) => void testModel(target, false));
    setBatchTesting(false);
  }, [batchTesting, testModel, testTargets]);

  const openNewModelModal = useCallback(() => {
    setEditing(null);
    setModelOptions([]);
    setDraft(emptyCursorModelDraft());
  }, []);

  const openEditModelModal = useCallback((model: Model) => {
    setEditing(model);
    setModelOptions([]);
    setDraft({
      providerId: `builtin/${model.type}`,
      model: {
        sort_order: model.sort_order,
        display_name: model.display_name,
        group_name: model.group_name,
        type: model.type,
        base_url: model.base_url,
        use_full_url: model.use_full_url,
        api_key: model.api_key,
        tooltip_data: model.tooltip_data,
        model_id: model.model_id,
        reasoning_effort: model.reasoning_effort,
        openai_endpoint: model.openai_endpoint,
        openai_extra_params_enabled: model.openai_extra_params_enabled,
        openai_extra_params: model.openai_extra_params,
        custom_headers_enabled: model.custom_headers_enabled,
        custom_headers: model.custom_headers,
        anthropic_extra_params_enabled: model.anthropic_extra_params_enabled,
        anthropic_extra_params: model.anthropic_extra_params,
        context_window_tokens: model.context_window_tokens,
        max_completion_tokens: model.max_completion_tokens,
        anthropic_max_tokens: model.anthropic_max_tokens,
        anthropic_thinking_effort: model.anthropic_thinking_effort,
        thinking_budget_tokens: model.thinking_budget_tokens,
      },
      openAIExtraParamsText: JSON.stringify(model.openai_extra_params, null, 2),
      customHeadersText: JSON.stringify(model.custom_headers, null, 2),
      anthropicExtraParamsText: JSON.stringify(model.anthropic_extra_params, null, 2),
    });
  }, []);

  const closeModal = useCallback(() => {
    setDraft(null);
    setEditing(null);
    setModelOptions([]);
  }, []);

  const saveModelDraft = useCallback(async () => {
    if (!draft) return false;
    try {
      const input = draftInput(draft);
      if (editing) {
        await api.updateModel(editing.model_hash, input);
      } else {
        await api.createModels([input]);
      }
      await appStore.refresh();
      closeModal();
      return true;
    } catch (cause) {
      message(errorText(cause));
      return false;
    }
  }, [closeModal, draft, editing, message]);

  const confirmDelete = useCallback(() => {
    if (!deleting) return;
    api.deleteModel(deleting.model_hash)
      .then(async () => {
        await appStore.refresh();
        setDeleting(null);
      })
      .catch((err) => message(errorText(err)));
  }, [deleting, message]);

  const discover = useCallback(async () => {
    if (!draft?.model.base_url || !draft?.model.api_key) return false;
    setDiscovering(true);
    try {
      const result = await api.discoverModels({
        type: draft.model.type,
        base_url: draft.model.base_url.trim(),
        api_key: draft.model.api_key.trim(),
        custom_headers_enabled: draft.model.custom_headers_enabled,
        custom_headers: draft.model.custom_headers,
      });
      setModelOptions(result.models);
      return result.models.length > 0;
    } catch (cause) {
      message(errorText(cause));
      return false;
    } finally {
      setDiscovering(false);
    }
  }, [draft, message]);

  const activeGroups = grouping === "provider" ? providerGroups : typeGroups;
  const pluginSectionHeight = pluginModels.length > 0 ? 60 + pluginModels.length * 56 : 0;
  const estimatedModelHeight = grouping === "flat"
    ? Math.max(380, Math.ceil(models.length / 3) * 196 + pluginSectionHeight)
    : Math.max(380, activeGroups.reduce((height: number, group: CursorModelGroup) => height + 60 + group.models.length * 56, 0) + Math.max(0, activeGroups.length - 1) * 20 + pluginSectionHeight);

  const mainContent = (
    <div className={styles.page}>
      <div style={{ padding: "0 0 8px 0", color: "var(--vscode-descriptionForeground)", fontSize: "13px" }}>
        Claude Code Desktop / CLI Gateway (http://127.0.0.1:{servicePort})
      </div>
      <CursorModelCards
        models={models}
        pluginModels={pluginModels}
        grouping={grouping}
        disabled={false}
        testingModelHashes={testingModelHashes}
        testResults={modelTestResults}
        onTest={(model) => void testModel(model)}
        onEdit={openEditModelModal}
        onDuplicate={(model) => {
          openEditModelModal(model);
          setEditing(null);
        }}
        onDelete={setDeleting}
        onTestPluginModel={(pModel) => void testModel({ model_hash: pModel.id, display_name: pModel.displayName })}
        onPluginSettings={() => navigate("/plugins")}
        onReorder={(hashes) => {
          void api.reorderModels(hashes).then(() => appStore.refresh());
        }}
        onGroupSettings={(group) => {
          setSettingsGroup(group);
          setGroupNameDraft(group.label);
          const first = group.models[0];
          setGroupBaseUrlDraft(first?.base_url ?? "");
          setGroupApiKeyDraft(first?.api_key ?? "");
        }}
      />
    </div>
  );

  return (
    <>
      <PageActions position="left">
        <div className={styles.takeoverActions}>
          <span className={styles.takeoverStatus}>{t("已接管")}</span>
          {testTargets.length > 0 && (
            <div className={styles.groupActions} role="group" aria-label={t("操作")}>
              <button type="button" aria-pressed={grouping === "flat"} onClick={() => setGrouping("flat")}>
                {t("默认平铺")}
              </button>
              {canGroupByProvider && (
                <button type="button" aria-pressed={grouping === "provider"} onClick={() => setGrouping("provider")}>
                  {t("按供应商")}
                </button>
              )}
              {canGroupByType && (
                <button type="button" aria-pressed={grouping === "type"} onClick={() => setGrouping("type")}>
                  {t("按类型")}
                </button>
              )}
              <button type="button" onClick={testAll}>
                {t("一键测试")}
              </button>
            </div>
          )}
        </div>
      </PageActions>

      <PageActions>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            type="button"
            className={controls.button}
            onClick={copyEndpoint}
            title="Copy Base URL"
          >
            {copiedBaseUrl ? <Icon icon={checkIcon} size="1.2em" /> : null}
            <span>{claudeBaseUrl}</span>
          </button>
          <TooltipTrigger label={t("添加模型")}>
            <button
              type="button"
              className={controls.iconButton}
              onClick={openNewModelModal}
            >
              <Icon icon={addIcon} size="1.1em" />
            </button>
          </TooltipTrigger>
        </div>
      </PageActions>

      <PageContent
        title="Claude"
        sections={[{ key: "claude-settings", estimatedHeight: estimatedModelHeight, content: mainContent }]}
      />

      <Modal
        fullHeight
        open={draft !== null}
        title={editing ? t("编辑模型") : t("添加模型")}
        busy={savingAndTesting}
        onClose={closeModal}
        onSubmit={() => void saveModelDraft()}
        submitLabel={t("保存")}
      >
        {draft && (
          <CursorModelEditor
            draft={draft}
            modelOptions={modelOptions}
            discovering={discovering}
            onChange={setDraft}
            onDiscover={discover}
          />
        )}
      </Modal>

      {settingsGroup && (
        <Modal
          open={true}
          title={t("分组设置")}
          busy={groupSettingsBusy}
          onClose={() => setSettingsGroup(null)}
          onSubmit={async () => {
            setGroupSettingsBusy(true);
            try {
              for (const model of settingsGroup.models) {
                await api.updateModel(model.model_hash, {
                  ...model,
                  group_name: groupNameDraft.trim() || null,
                  base_url: groupBaseUrlDraft.trim() || model.base_url,
                  api_key: groupApiKeyDraft.trim() || model.api_key,
                });
              }
              await appStore.refresh();
              setSettingsGroup(null);
            } catch (err) {
              message(errorText(err));
            } finally {
              setGroupSettingsBusy(false);
            }
          }}
          submitLabel={t("保存")}
        >
          <div className={styles.editor}>
            <FormField label={t("分组名称")}>
              <TextInput placeholder={settingsGroup.key} value={groupNameDraft} onChange={(e: ChangeEvent<HTMLInputElement>) => setGroupNameDraft(e.target.value)} />
            </FormField>
            <FormField label={t("服务器地址")}>
              <TextInput placeholder={t("留空保持不变")} value={groupBaseUrlDraft} onChange={(e: ChangeEvent<HTMLInputElement>) => setGroupBaseUrlDraft(e.target.value)} />
            </FormField>
            <FormField label="API Key">
              <SecretTextInput placeholder={t("留空保持不变")} autoComplete="off" value={groupApiKeyDraft} onChange={(e: ChangeEvent<HTMLInputElement>) => setGroupApiKeyDraft(e.target.value)} />
            </FormField>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          open={true}
          title={t("删除模型")}
          confirmLabel={t("删除")}
          cancelLabel={t("取消")}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        >
          <p>{t("确定删除这个模型吗？")}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
