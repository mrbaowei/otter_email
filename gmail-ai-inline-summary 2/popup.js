const enabled = document.getElementById("enabled");
const status = document.getElementById("status");

chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
  if (!response?.ok) {
    status.textContent = "读取设置失败";
    return;
  }
  enabled.checked = Boolean(response.settings.enabled);
  status.textContent = response.settings.apiKey
    ? `${providerName(response.settings.provider)} · ${response.settings.model}`
    : "尚未配置 API Key";
});

enabled.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: { enabled: enabled.checked } });
});

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function providerName(provider) {
  return { deepseek: "DeepSeek", openai: "OpenAI 官方", openrouter: "OpenRouter", gemini: "Google AI Studio", custom: "自定义兼容接口" }[provider] || provider;
}
