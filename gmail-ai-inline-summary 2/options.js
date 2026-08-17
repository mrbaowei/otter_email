const PRESETS = {
  deepseek: { endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-chat" },
  openai: { endpoint: "https://api.openai.com/v1/responses", model: "gpt-4.1-mini" },
  openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "openai/gpt-4.1-mini" },
  gemini: { endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", model: "gemini-2.5-flash" },
  custom: { endpoint: "", model: "" }
};

const PROVIDER_HELP = {
  custom: {
    endpoint: "填写完整的 OpenAI Chat Completions 兼容地址，例如 https://example.com/v1/chat/completions。",
    key: "填写该兼容服务提供的 API Key；无鉴权的 localhost/127.0.0.1 本地接口可以留空。",
    placeholder: "sk-… 或服务商 Key",
    thinking: "默认关闭；对支持 reasoning_effort 的兼容模型请求关闭或中等思考。"
  },
  openai: {
    endpoint: "OpenAI 官方 Responses API；Endpoint 固定，只需填写模型和 OpenAI Platform API Key。",
    key: "这里需要 OpenAI Platform API Key，不能使用 ChatGPT/Codex 登录令牌或订阅额度。",
    placeholder: "sk-proj-…",
    thinking: "GPT-5 等推理模型可切换关闭或中等思考；普通模型关闭时不添加推理参数。"
  },
  gemini: {
    endpoint: "Google AI Studio Gemini generateContent API；{model} 会自动替换为模型名称。",
    key: "填写在 Google AI Studio 创建的 Gemini API Key。",
    placeholder: "Google AI Studio API Key",
    thinking: "Gemini 2.5 Flash 可关闭思考；Gemini 3 系列无法完全关闭，关闭开关时使用最低兼容档 LOW。"
  },
  deepseek: {
    endpoint: "DeepSeek 的 OpenAI Chat Completions 兼容预设。",
    key: "填写 DeepSeek API Key。",
    placeholder: "sk-…",
    thinking: "DeepSeek 的思考能力由模型决定；deepseek-chat 默认不思考。"
  },
  openrouter: {
    endpoint: "OpenRouter 的 OpenAI Chat Completions 兼容预设。",
    key: "填写 OpenRouter API Key。",
    placeholder: "sk-or-…",
    thinking: "通过 OpenRouter 统一 reasoning 参数切换关闭或中等思考。"
  }
};

const form = document.getElementById("settings-form");
const statusEl = document.getElementById("status");
const generalFields = ["enabled", "summaryLanguage", "detailLevel", "maxInputChars", "alwaysDetailed"];
let providerConfigs = {};
let activeProvider = "";
const tokenTotalEl = document.getElementById("token-total");
const tokenUsageCountEl = document.getElementById("token-usage-count");
const tokenUsageNoteEl = document.getElementById("token-usage-note");
const tokenUsageBodyEl = document.getElementById("token-usage-body");
const numberFormatter = new Intl.NumberFormat("zh-CN");
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const CONFIG_EXPORT_VERSION = 1;

init();

async function init() {
  const response = await sendMessage({ type: "GET_PRIVATE_SETTINGS" });
  if (!response?.ok) return showStatus(response?.error || "读取设置失败", true);
  for (const id of generalFields) {
    const element = document.getElementById(id);
    if (element.type === "checkbox") element.checked = Boolean(response.settings[id]);
    else element.value = response.settings[id] ?? "";
  }
  providerConfigs = cloneProviderConfigs(response.settings.providerConfigs || {});
  activeProvider = response.settings.provider || "openai";
  providerConfigs[activeProvider] = normalizeProviderConfig(activeProvider, {
    ...(providerConfigs[activeProvider] || {}),
    endpoint: response.settings.endpoint,
    model: response.settings.model,
    apiKey: response.settings.apiKey,
    thinkingEnabled: response.settings.thinkingEnabled
  });
  document.getElementById("provider").value = activeProvider;
  loadProviderConfig(activeProvider);
  await loadTokenUsage();
}

document.getElementById("provider").addEventListener("change", (event) => {
  saveProviderDraft(activeProvider);
  activeProvider = event.target.value;
  loadProviderConfig(activeProvider);
});

document.getElementById("toggle-key").addEventListener("click", (event) => {
  const input = document.getElementById("apiKey");
  input.type = input.type === "password" ? "text" : "password";
  event.currentTarget.textContent = input.type === "password" ? "显示" : "隐藏";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = collectFormSettings();

  if (!settings.endpoint || !settings.model) return showStatus("请填写 Endpoint 和模型名称", true);
  if (settings.provider === "custom") {
    const granted = await requestEndpointPermission(settings.endpoint);
    if (!granted) return showStatus("未获得自定义 API 域名访问权限", true);
  }

  const response = await sendMessage({ type: "SAVE_SETTINGS", settings });
  if (!response?.ok) return showStatus(response?.error || "保存失败", true);
  showStatus("已保存。重新打开或切换一封邮件即可看到摘要。", false);
});

document.getElementById("test-provider").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const testStatus = document.getElementById("model-test-status");
  const settings = collectFormSettings();
  testStatus.className = "";
  if (!settings.endpoint || !settings.model) {
    testStatus.textContent = "请先填写 Endpoint 和模型名称";
    testStatus.className = "test-error";
    return;
  }
  if (settings.provider === "custom") {
    const granted = await requestEndpointPermission(settings.endpoint);
    if (!granted) {
      testStatus.textContent = "未获得接口域名访问权限";
      testStatus.className = "test-error";
      return;
    }
  }

  button.disabled = true;
  button.textContent = "测试中…";
  testStatus.textContent = "正在发送最小测试请求";
  const response = await sendMessage({ type: "TEST_PROVIDER", settings });
  button.disabled = false;
  button.textContent = "测试连接";
  if (!response?.ok || !response.test?.connected) {
    testStatus.textContent = response?.error || "连接失败";
    testStatus.className = "test-error";
    return;
  }
  testStatus.textContent = `连接成功 · ${response.test.latencyMs} ms`;
  testStatus.className = "test-success";
});

document.getElementById("export-config").addEventListener("click", () => {
  const payload = {
    format: "email-otter-config",
    version: CONFIG_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: collectFormSettings()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `email-otter-config-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showStatus("配置已导出。文件包含 API Key，请妥善保存。", false);
});

const importConfigFile = document.getElementById("import-config-file");
document.getElementById("import-config").addEventListener("click", () => {
  importConfigFile.value = "";
  importConfigFile.click();
});

importConfigFile.addEventListener("change", async () => {
  const file = importConfigFile.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const imported = validateImportedConfig(payload);
    const response = await sendMessage({ type: "SAVE_SETTINGS", settings: imported });
    if (!response?.ok) throw new Error(response?.error || "写入配置失败");
    applySettingsToForm(response.settings);
    showStatus("配置已导入并立即生效。刷新邮箱页面即可使用。", false);
  } catch (error) {
    showStatus(`导入失败：${error.message || "配置文件无效"}`, true);
  }
});

function collectFormSettings() {
  saveProviderDraft(activeProvider);
  const settings = Object.fromEntries(generalFields.map((id) => {
    const element = document.getElementById(id);
    return [id, element.type === "checkbox" ? element.checked : element.value.trim()];
  }));
  settings.provider = activeProvider;
  settings.providerConfigs = cloneProviderConfigs(providerConfigs);
  Object.assign(settings, providerConfigs[activeProvider]);
  settings.maxInputChars = Number(settings.maxInputChars);
  return settings;
}

function validateImportedConfig(payload) {
  if (!payload || payload.format !== "email-otter-config" || payload.version !== CONFIG_EXPORT_VERSION) {
    throw new Error("这不是受支持的 Email Otter 配置文件");
  }
  const settings = payload.settings;
  if (!settings || typeof settings !== "object" || !PRESETS[settings.provider]) {
    throw new Error("配置内容缺失或服务商不受支持");
  }
  const configs = cloneProviderConfigs(settings.providerConfigs || {});
  const active = configs[settings.provider];
  if (!active.endpoint || !active.model) throw new Error("当前服务商缺少 Endpoint 或模型名称");
  return {
    enabled: settings.enabled !== false,
    summaryLanguage: String(settings.summaryLanguage || "简体中文").slice(0, 80),
    detailLevel: ["brief", "standard", "detailed"].includes(settings.detailLevel) ? settings.detailLevel : "brief",
    alwaysDetailed: Boolean(settings.alwaysDetailed),
    maxInputChars: Math.min(120000, Math.max(5000, Number(settings.maxInputChars) || 50000)),
    provider: settings.provider,
    providerConfigs: configs,
    ...active
  };
}

function applySettingsToForm(settings) {
  for (const id of generalFields) {
    const element = document.getElementById(id);
    if (element.type === "checkbox") element.checked = Boolean(settings[id]);
    else element.value = settings[id] ?? "";
  }
  providerConfigs = cloneProviderConfigs(settings.providerConfigs || {});
  activeProvider = settings.provider || "openai";
  document.getElementById("provider").value = activeProvider;
  loadProviderConfig(activeProvider);
}

function loadProviderConfig(provider) {
  const config = normalizeProviderConfig(provider, providerConfigs[provider]);
  providerConfigs[provider] = config;
  document.getElementById("endpoint").value = config.endpoint;
  document.getElementById("model").value = config.model;
  document.getElementById("apiKey").value = config.apiKey;
  document.getElementById("thinkingEnabled").checked = config.thinkingEnabled;

  const help = PROVIDER_HELP[provider] || PROVIDER_HELP.custom;
  const endpoint = document.getElementById("endpoint");
  endpoint.readOnly = provider !== "custom";
  document.getElementById("endpoint-help").textContent = help.endpoint;
  document.getElementById("api-key-help").textContent = `${help.key} Key 仅保存在本机 Chrome 扩展存储。`;
  document.getElementById("thinking-help").textContent = help.thinking;
  document.getElementById("apiKey").placeholder = help.placeholder;
}

function saveProviderDraft(provider) {
  if (!provider) return;
  providerConfigs[provider] = normalizeProviderConfig(provider, {
    endpoint: document.getElementById("endpoint").value.trim(),
    model: document.getElementById("model").value.trim(),
    apiKey: document.getElementById("apiKey").value.trim(),
    thinkingEnabled: document.getElementById("thinkingEnabled").checked
  });
}

function normalizeProviderConfig(provider, value = {}) {
  const preset = PRESETS[provider] || PRESETS.custom;
  return {
    endpoint: String(value.endpoint || preset.endpoint || "").trim(),
    model: String(value.model || preset.model || "").trim(),
    apiKey: String(value.apiKey || "").trim(),
    thinkingEnabled: value.thinkingEnabled === true
  };
}

function cloneProviderConfigs(value) {
  return Object.fromEntries(Object.keys(PRESETS).map((provider) => [
    provider,
    normalizeProviderConfig(provider, value?.[provider])
  ]));
}

document.getElementById("clear-cache").addEventListener("click", async () => {
  const response = await sendMessage({ type: "CLEAR_CACHE" });
  showStatus(response?.ok ? "摘要缓存已清空" : (response?.error || "清理失败"), !response?.ok);
});

document.getElementById("clear-token-usage").addEventListener("click", async () => {
  const response = await sendMessage({ type: "CLEAR_TOKEN_USAGE" });
  if (!response?.ok) return showStatus(response?.error || "清理失败", true);
  await loadTokenUsage();
  showStatus("Token 用量记录已清空", false);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes["tokenUsage:v1"]) loadTokenUsage();
});

async function loadTokenUsage() {
  const response = await sendMessage({ type: "GET_TOKEN_USAGE" });
  if (!response?.ok) {
    tokenUsageNoteEl.textContent = response?.error || "Token 用量读取失败";
    return;
  }
  renderTokenUsage(response.usage || {});
}

function renderTokenUsage(usage) {
  const items = Array.isArray(usage.items) ? usage.items : [];
  const totalTokens = Number.isFinite(Number(usage.totalTokens)) ? Number(usage.totalTokens) : 0;
  const recordCount = Number.isFinite(Number(usage.recordCount)) ? Number(usage.recordCount) : items.length;
  const estimatedCount = Number.isFinite(Number(usage.estimatedRecordCount)) ? Number(usage.estimatedRecordCount) : 0;

  tokenTotalEl.textContent = formatNumber(totalTokens);
  tokenUsageCountEl.textContent = `${formatNumber(recordCount)} 次摘要请求`;
  tokenUsageNoteEl.textContent = estimatedCount
    ? `只记录实际发起的摘要请求，不保存邮件正文；${formatNumber(estimatedCount)} 次接口未返回 usage，使用文本长度估算。表格保留最近 500 条，累计值不受表格条数影响。`
    : "只记录实际发起的摘要请求，不保存邮件正文；当前记录均使用接口返回的精确 usage。表格保留最近 500 条，累计值不受表格条数影响。";

  tokenUsageBodyEl.replaceChildren();
  if (!items.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "usage-empty";
    cell.textContent = "还没有摘要用量记录";
    row.append(cell);
    tokenUsageBodyEl.append(row);
    return;
  }

  for (const item of items) {
    const row = document.createElement("tr");
    appendCell(row, formatDate(item.timestamp));
    appendStackedCell(row, item.provider || "邮箱", item.model || "未知模型");
    appendStackedCell(row, item.subject || "（无主题）", `${item.mode === "detail" ? "详细摘要" : "快速摘要"} · ${item.messageCount || 1} 封`);
    appendCell(row, formatToken(item.promptTokens));
    appendCell(row, formatToken(item.completionTokens));
    appendCell(row, formatToken(item.totalTokens, item.estimated));
    tokenUsageBodyEl.append(row);
  }
}

function appendCell(row, text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  row.append(cell);
}

function appendStackedCell(row, primary, secondary) {
  const cell = document.createElement("td");
  const strong = document.createElement("strong");
  strong.textContent = primary;
  const small = document.createElement("small");
  small.textContent = secondary;
  cell.append(strong, small);
  row.append(cell);
}

function formatNumber(value) {
  return numberFormatter.format(Math.max(0, Math.round(Number(value) || 0)));
}

function formatToken(value, estimated = false) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "—";
  return `${estimated ? "≈" : ""}${formatNumber(value)}`;
}

function formatDate(timestamp) {
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

async function requestEndpointPermission(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      showStatus("自定义接口必须使用 HTTPS；本机 localhost/127.0.0.1 可使用 HTTP", true);
      return false;
    }
    const origin = `${url.protocol}//${url.host}/*`;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    showStatus("自定义 Endpoint 地址不合法", true);
    return false;
  }
}

function showStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#b13b32" : "#087a49";
}

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}
