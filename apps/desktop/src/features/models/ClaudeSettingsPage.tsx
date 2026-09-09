import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, configuredPluginModels, type Model, type ModelInput } from "../../shared/api";
import { CursorModelCards, cursorModelGroups, type CursorModelGroup, type CursorModelGrouping } from "./CursorModelCards";
import { CursorModelEditor, emptyCursorModelDraft, type CursorModelDraft } from "./CursorModelEditor";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
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
  const [savingAndTesting, setSavingAndTesting] = useState(false);
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

  const startTest = useCallback((modelHash: string, displayName: string) => {
    const previous = activeModelTests.current.get(modelHash);
    if (previous) {
      previous.cancelling = true;
      previous.controller.abort();
      activeModelTests.current.delete(modelHash);
    }
    const controller = new AbortController();
    const testId = crypto.randomUUID();
    activeModelTests.current.set(modelHash, { testId, controller, cancelling: false });
    setTestingModelHashes((current) => new Set(current).add(modelHash));
    setModelTestResults((current) => {
      const next = new Map(current);
      next.set(modelHash, {
        status: "testing",
        displayName,
        result: null,
      });
      return next;
    });

    api.testModel(modelHash, testId, controller.signal)
      .then((result) => {
        if (activeModelTests.current.get(modelHash)?.testId !== testId) return;
        setModelTestResults((current) => {
          const next = new Map(current);
          next.set(modelHash, {
            status: "success",
            displayName,
            result,
          });
          return next;
        });
      })
      .catch((error) => {
        const tracked = activeModelTests.current.get(modelHash);
        if (tracked?.testId !== testId) return;
        if (tracked.cancelling || controller.signal.aborted) {
          setModelTestResults((current) => {
            const next = new Map(current);
            next.delete(modelHash);
            return next;
          });
          return;
        }
        setModelTestResults((current) => {
          const next = new Map(current);
          next.set(modelHash, {
            status: "error",
            displayName,
            result: {
              success: false,
              model_hash: modelHash,
              display_name: displayName,
              model_id: "",
              error: error instanceof Error ? error.message : String(error),
              first_token_latency_ms: 0,
              total_latency_ms: 0,
              token_rate: 0,
              total_tokens: 0,
              stream_details: null,
              recorded_call_id: null,
            },
          });
          return next;
        });
      })
      .finally(() => {
        if (activeModelTests.current.get(modelHash)?.testId === testId) {
          activeModelTests.current.delete(modelHash);
          setTestingModelHashes((current) => {
            const next = new Set(current);
            next.delete(modelHash);
            return next;
          });
        }
      });
  }, []);

  const testModel = useCallback((model: Model) => {
    startTest(model.model_hash, model.display_name);
  }, [startTest]);

  const testAll = useCallback(() => {
    if (batchTesting) return;
    setBatchTesting(true);
    testTargets.forEach((target) => startTest(target.model_hash, target.display_name));
    setBatchTesting(false);
  }, [batchTesting, startTest, testTargets]);

  const openNewModelModal = useCallback(() => {
    setEditing(null);
    setModelOptions([]);
    setDraft(emptyCursorModelDraft());
  }, []);

  const openEditModelModal = useCallback((model: Model) => {
    setEditing(model);
    setModelOptions([]);
    setDraft({
      sortOrder: model.sort_order,
      displayName: model.display_name,
      groupName: model.group_name ?? "",
      type: model.type,
      baseUrl: model.base_url,
      useFullUrl: model.use_full_url,
      apiKey: model.api_key,
      tooltipData: model.tooltip_data,
      modelId: model.model_id,
      reasoningEffort: model.reasoning_effort,
      openaiEndpoint: model.openai_endpoint,
      openaiExtraParamsEnabled: model.openai_extra_params_enabled,
      openaiExtraParamsJson: JSON.stringify(model.openai_extra_params, null, 2),
      customHeadersEnabled: model.custom_headers_enabled,
      customHeadersJson: JSON.stringify(model.custom_headers, null, 2),
      anthropicExtraParamsEnabled: model.anthropic_extra_params_enabled,
      anthropicExtraParamsJson: JSON.stringify(model.anthropic_extra_params, null, 2),
      contextWindowTokens: model.context_window_tokens,
      maxCompletionTokens: model.max_completion_tokens,
      anthropicMaxTokens: model.anthropic_max_tokens,
      anthropicThinkingEffort: model.anthropic_thinking_effort,
      thinkingBudgetTokens: model.thinking_budget_tokens,
    });
  }, []);

  const closeModal = useCallback(() => {
    setDraft(null);
    setEditing(null);
    setModelOptions([]);
  }, []);

  const saveModelDraft = useCallback((toSave: CursorModelDraft) => {
    const input: ModelInput = {
      sort_order: toSave.sortOrder,
      display_name: toSave.displayName.trim(),
      group_name: toSave.groupName.trim() ? toSave.groupName.trim() : null,
      type: toSave.type,
      base_url: toSave.baseUrl.trim(),
      use_full_url: toSave.useFullUrl,
      api_key: toSave.apiKey,
      tooltip_data: toSave.tooltipData,
      model_id: toSave.modelId.trim(),
      reasoning_effort: toSave.reasoningEffort,
      openai_endpoint: toSave.openaiEndpoint,
      openai_extra_params_enabled: toSave.openaiExtraParamsEnabled,
      openai_extra_params: toSave.openaiExtraParamsJson ? JSON.parse(toSave.openaiExtraParamsJson) : {},
      custom_headers_enabled: toSave.customHeadersEnabled,
      custom_headers: toSave.customHeadersJson ? JSON.parse(toSave.customHeadersJson) : {},
      anthropic_extra_params_enabled: toSave.anthropicExtraParamsEnabled,
      anthropic_extra_params: toSave.anthropicExtraParamsJson ? JSON.parse(toSave.anthropicExtraParamsJson) : {},
      context_window_tokens: toSave.contextWindowTokens,
      max_completion_tokens: toSave.maxCompletionTokens,
      anthropic_max_tokens: toSave.anthropicMaxTokens,
      anthropic_thinking_effort: toSave.anthropicThinkingEffort,
      thinking_budget_tokens: toSave.thinkingBudgetTokens,
    };

    const action = editing
      ? api.updateModel(editing.model_hash, input)
      : api.createModels([input]);

    return action.then((result) => {
      void appStore.load();
      closeModal();
      return result;
    });
  }, [closeModal, editing]);

  const confirmDelete = useCallback(() => {
    if (!deleting) return;
    api.deleteModel(deleting.model_hash)
      .then(() => {
        void appStore.load();
        setDeleting(null);
      })
      .catch((err) => message(err instanceof Error ? err.message : String(err)));
  }, [deleting, message]);

  return (
    <PageContent
      title={
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span>Claude</span>
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontWeight: "normal" }}>
            (Claude Code CLI & Desktop 网关)
          </span>
        </div>
      }
      actions={
        <PageActions>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              className={controls.button}
              onClick={copyEndpoint}
              title={t("点击复制 Base URL")}
            >
              {copiedBaseUrl ? <Icon icon={checkIcon} size="1.2em" /> : null}
              <span>{claudeBaseUrl}</span>
            </button>
            <button
              type="button"
              className={controls.button}
              onClick={testAll}
              disabled={models.length === 0}
            >
              {t("一键测试")}
            </button>
            <button
              type="button"
              className={`${controls.button} ${controls.primaryButton}`}
              onClick={openNewModelModal}
            >
              <Icon icon={addIcon} size="1.2em" />
              <span>{t("添加模型")}</span>
            </button>
          </div>
        </PageActions>
      }
    >
      <div style={{ padding: "0 0 16px 0", color: "var(--color-text-secondary)", fontSize: "13px" }}>
        Claude Code Desktop / CLI Gateway (http://127.0.0.1:{servicePort})
      </div>

      <CursorModelCards
        models={models}
        pluginModels={pluginModels}
        grouping={grouping}
        disabled={false}
        testingModelHashes={testingModelHashes}
        testResults={modelTestResults}
        onTest={testModel}
        onEdit={openEditModelModal}
        onDuplicate={(model) => {
          setEditing(null);
          setDraft({
            ...model,
            sortOrder: model.sort_order + 1,
            displayName: `${model.display_name} (Copy)`,
            groupName: model.group_name ?? "",
            baseUrl: model.base_url,
            useFullUrl: model.use_full_url,
            apiKey: model.api_key,
            tooltipData: model.tooltip_data,
            modelId: model.model_id,
            reasoningEffort: model.reasoning_effort,
            openaiEndpoint: model.openai_endpoint,
            openaiExtraParamsEnabled: model.openai_extra_params_enabled,
            openaiExtraParamsJson: JSON.stringify(model.openai_extra_params, null, 2),
            customHeadersEnabled: model.custom_headers_enabled,
            customHeadersJson: JSON.stringify(model.custom_headers, null, 2),
            anthropicExtraParamsEnabled: model.anthropic_extra_params_enabled,
            anthropicExtraParamsJson: JSON.stringify(model.anthropic_extra_params, null, 2),
            contextWindowTokens: model.context_window_tokens,
            maxCompletionTokens: model.max_completion_tokens,
            anthropicMaxTokens: model.anthropic_max_tokens,
            anthropicThinkingEffort: model.anthropic_thinking_effort,
            thinkingBudgetTokens: model.thinking_budget_tokens,
          });
        }}
        onDelete={(model) => setDeleting(model)}
        onTestPluginModel={(pModel) => startTest(pModel.id, pModel.displayName)}
        onPluginSettings={() => navigate("/plugins")}
        onReorder={(hashes) => {
          void api.reorderModels(hashes).then(() => appStore.load());
        }}
        onGroupSettings={(group) => {
          setSettingsGroup(group);
          setGroupNameDraft(group.label);
          const first = group.models[0];
          setGroupBaseUrlDraft(first?.base_url ?? "");
          setGroupApiKeyDraft(first?.api_key ?? "");
        }}
      />

      {draft && (
        <Modal open={true} onClose={closeModal} title={editing ? t("编辑模型") : t("添加模型")}>
          <CursorModelEditor
            draft={draft}
            editing={Boolean(editing)}
            modelOptions={modelOptions}
            discovering={discovering}
            savingAndTesting={savingAndTesting}
            busy={false}
            onChange={(patch) => setDraft((current) => (current ? { ...current, ...patch } : null))}
            onDiscoverModels={() => {}}
            onSave={() => {
              if (draft) void saveModelDraft(draft);
            }}
            onSaveAndTest={() => {
              if (!draft) return;
              setSavingAndTesting(true);
              void saveModelDraft(draft).finally(() => setSavingAndTesting(false));
            }}
            onCancel={closeModal}
          />
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          id="delete-model-dialog"
          open={Boolean(deleting)}
          title={t("删除模型")}
          confirmLabel={t("删除")}
          cancelLabel={t("取消")}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        >
          <p>{t("确定删除这个模型吗？")}</p>
        </ConfirmDialog>
      )}
    </PageContent>
  );
}
