(() => {
  const CARD_ID = "email-otter-summary-card";
  const LEGACY_CARD_ID = "gmail-ai-inline-summary-card";
  const TASK_ORB_ID = "email-otter-task-orb";
  const TRANSLATE_DOCK_ID = "email-otter-translate-dock";
  const TRANSLATE_TRIGGER_ID = "email-otter-translate-trigger";
  const TASK_INDEX_KEY = "taskIndex:v1";
  const BUILD_VERSION = "0.7.20";
  const BRIEF_CACHE_PREFIX = "summaryCache:brief-v8:";
  const DETAIL_CACHE_PREFIX = "summaryCache:detail-v1:";
  const TRANSLATION_CACHE_PREFIX = "summaryCache:translation-v1:";
  const MAX_CACHE_ITEMS = 200;
  const SITE = window.EmailOtterSite;
  const SELECTORS = SITE?.selectors;

  if (!SITE || !SELECTORS) return;

  let observer;
  let scanTimer;
  let scanDueAt = 0;
  let currentSignature = "";
  let currentThreadKey = "";
  let generation = 0;
  let taskOrbCountFlashUntil = 0;
  let taskOrbCountFlashTimer;
  let missingThreadSince = 0;
  let briefRequestInFlightKey = "";
  const briefResultsByThreadKey = new Map();

  start();

  function start() {
    // 邮箱首屏会持续修改 DOM。首次扫描必须尽快执行，不能等待页面完全静止。
    scheduleScan(150);
    observer = new MutationObserver(() => scheduleScan(450));
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("hashchange", () => {
      currentSignature = "";
      currentThreadKey = "";
      scheduleScan(300);
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes.settings) {
        currentSignature = "";
        currentThreadKey = "";
        briefRequestInFlightKey = "";
        briefResultsByThreadKey.clear();
        scheduleScan(200);
      }
      if (changes[TASK_INDEX_KEY]) refreshTaskOrb();
    });
    ensureTaskOrb();
    refreshTaskOrb();

    // 保底机制：即使某次页面更新没有被选择器命中，也会再次检查。
    // 已经显示相同邮件的卡片时，scanForThread 会立即返回，不会重复请求模型。
    setInterval(() => {
      if (!document.hidden) scheduleScan(0);
    }, 3000);
  }

  function scheduleScan(delay = 500) {
    const desiredAt = Date.now() + delay;

    // 使用节流而不是纯 debounce。邮箱即使一直有 DOM 动画/刷新，最早安排的
    // 扫描也一定会执行；只有更早的扫描请求才会替换现有定时器。
    if (scanTimer && desiredAt >= scanDueAt) return;
    if (scanTimer) clearTimeout(scanTimer);

    scanDueAt = desiredAt;
    scanTimer = setTimeout(async () => {
      scanTimer = null;
      scanDueAt = 0;
      try {
        if (!extensionAvailable()) return;
        await scanForThread();
      } catch (error) {
        if (isExtensionContextUnavailable(error)) return;
        console.warn(`[Email Otter ${BUILD_VERSION} · ${SITE.label}] scan failed`, error);
      }
    }, Math.max(0, desiredAt - Date.now()));
  }

  async function scanForThread() {
    if (!extensionAvailable()) return;
    const settingsResponse = await sendMessage({ type: "GET_SETTINGS" });
    const settings = settingsResponse?.settings;
    if (!settings?.enabled) {
      document.getElementById(CARD_ID)?.remove();
      document.getElementById(LEGACY_CARD_ID)?.remove();
      removeTranslationControls();
      return;
    }

    const thread = extractThread();
    if (!thread) {
      const existing = document.getElementById(CARD_ID);
      if (existing?.isConnected) {
        missingThreadSince ||= Date.now();
        if (Date.now() - missingThreadSince < 5000) {
          scheduleScan(800);
          return;
        }
      }
      document.getElementById(CARD_ID)?.remove();
      document.getElementById(LEGACY_CARD_ID)?.remove();
      removeTranslationControls();
      currentSignature = "";
      currentThreadKey = "";
      return;
    }
    missingThreadSince = 0;
    const threadKey = hashString(JSON.stringify({
      route: `${location.pathname}${location.hash}`,
      provider: SITE.key,
      subject: thread.subject
    }));
    const signature = hashString(JSON.stringify({
      route: `${location.pathname}${location.hash}`,
      modelProvider: settings.provider,
      model: settings.model,
      thinkingEnabled: settings.thinkingEnabled === true,
      subject: thread.subject,
      messages: thread.messages.map((item) => [item.sender, item.date, item.body]),
      attachments: thread.attachments
    }));

    const existing = document.getElementById(CARD_ID);
    if ((threadKey === currentThreadKey || signature === currentSignature) && existing?.isConnected) {
      // 邮箱会在不切换邮件的情况下重排阅读窗格；每次扫描都校正旧卡片的锚点，
      // 尤其避免 Outlook 把旧卡片留在空白的中间列。
      placeCard(existing, thread);
      ensureTranslationControls(existing, signature);
      const sessionResult = briefResultsByThreadKey.get(threadKey);
      if (sessionResult && !existing._briefSummary) {
        existing._threadKey = threadKey;
        existing.dataset.signature = signature;
        renderBriefSummary(existing, sessionResult, thread, signature, generation, settings, true);
      }
      return;
    }
    currentThreadKey = threadKey;
    currentSignature = signature;
    generation += 1;
    const myGeneration = generation;

    const card = ensureCard(thread);
    card._threadKey = threadKey;
    card.dataset.signature = signature;
    renderLoading(card, thread, "正在快速提炼结论…");

    const sessionResult = briefResultsByThreadKey.get(threadKey);
    if (sessionResult) {
      renderBriefSummary(card, sessionResult, thread, signature, myGeneration, settings, true);
      return;
    }

    const cacheKey = `${BRIEF_CACHE_PREFIX}${signature}`;
    const cached = await chrome.storage.local.get(cacheKey);
    if (myGeneration !== generation) return;
    if (cached[cacheKey]?.summary) {
      briefResultsByThreadKey.set(threadKey, cached[cacheKey].summary);
      renderBriefSummary(card, cached[cacheKey].summary, thread, signature, myGeneration, settings, true);
      if (!isNoReplySummary(cached[cacheKey].summary, thread)) {
        syncTasks(thread, cached[cacheKey].summary, signature, "brief").catch(() => {});
        if (settings.alwaysDetailed) await openDetailSummary(card);
      }
      return;
    }

    if (!settings.apiKey) {
      renderSetup(card);
      return;
    }
    await generateBriefSummary(card, thread, signature, myGeneration, settings);
  }

  async function generateBriefSummary(card, thread, signature, myGeneration, settings, force = false) {
    const requestKey = card._threadKey || signature;
    if (briefRequestInFlightKey === requestKey) return;
    briefRequestInFlightKey = requestKey;
    renderLoading(card, thread, force ? "正在重新提炼结论…" : "正在快速提炼结论…");
    let response;
    try {
      response = await sendMessage({ type: "SUMMARIZE_BRIEF", payload: thread });
    } finally {
      if (briefRequestInFlightKey === requestKey) briefRequestInFlightKey = "";
    }
    if (!response?.ok) {
      if (myGeneration !== generation || card.dataset.signature !== signature) return;
      renderError(card, response?.error || "摘要生成失败", thread, signature, settings);
      return;
    }
    briefResultsByThreadKey.set(requestKey, response.summary);
    if (briefResultsByThreadKey.size > 30) briefResultsByThreadKey.delete(briefResultsByThreadKey.keys().next().value);
    if (myGeneration !== generation || card.dataset.signature !== signature) {
      scheduleScan(0);
      return;
    }
    const cacheKey = `${BRIEF_CACHE_PREFIX}${signature}`;
    await chrome.storage.local.set({
      [cacheKey]: { summary: response.summary, createdAt: Date.now() }
    });
    pruneCache().catch(() => {});
    renderBriefSummary(card, response.summary, thread, signature, myGeneration, settings, false);
    if (!isNoReplySummary(response.summary, thread)) {
      syncTasks(thread, response.summary, signature, "brief").catch(() => {});
      if (settings.alwaysDetailed) await openDetailSummary(card);
    }
  }

  function extractThread() {
    const subjectEl = findSubjectElement();
    if (!subjectEl) return null;

    const allBodies = findBodyElements()
      .filter((element, index, list) => !list.some((other, otherIndex) => otherIndex !== index && other.contains(element)));
    if (!allBodies.length) return null;
    if (SITE.key === "qq" && !isQQReadingView(subjectEl, allBodies)) return null;

    const messages = [];
    const seen = new Set();
    for (const bodyEl of allBodies) {
      const body = extractBody(bodyEl);
      if (!body || body.length < 2) continue;
      const root = findMessageRoot(bodyEl);
      const senderEl = root?.querySelector(SELECTORS.sender) || nearestQuery(bodyEl, SELECTORS.sender);
      const dateEl = root?.querySelector(SELECTORS.date) || nearestQuery(bodyEl, SELECTORS.date);
      const sender = senderEl?.getAttribute("email") || senderEl?.textContent?.trim() || "";
      const date = dateEl?.getAttribute("title") || dateEl?.textContent?.trim() || "";
      const dedupeKey = hashString(`${sender}\n${date}\n${body}`);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      messages.push({ sender, date, body });
    }
    if (!messages.length) return null;

    const attachments = [...new Set(
      visibleElements(document.querySelectorAll(SELECTORS.attachments))
        .map((element) => element.textContent?.trim())
        .filter(Boolean)
    )].slice(0, 30);
    const links = extractThreadLinks(allBodies);

    return {
      provider: SITE.key,
      providerLabel: SITE.label,
      subject: subjectEl.textContent?.trim() || "（无主题）",
      messages,
      attachments,
      links,
      extractedAt: new Date().toISOString()
    };
  }

  function extractThreadLinks(bodyElements) {
    const links = [];
    const seen = new Set();
    for (const bodyEl of bodyElements) {
      let root = bodyEl;
      if (bodyEl instanceof HTMLIFrameElement) {
        try { root = bodyEl.contentDocument?.body; } catch { root = null; }
      }
      if (!root?.querySelectorAll) continue;
      for (const anchor of root.querySelectorAll("a[href]")) {
        const href = sanitizeEmailLink(anchor.getAttribute("href") || anchor.href);
        if (!href || seen.has(href)) continue;
        const text = (anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 120);
        if (isLowValueEmailLink(href, text)) continue;
        seen.add(href);
        links.push({ href, text });
        if (links.length >= 20) return links;
      }
    }
    return links;
  }

  function sanitizeEmailLink(raw) {
    try {
      const url = new URL(raw, location.href);
      if (!['https:', 'http:'].includes(url.protocol)) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function isLowValueEmailLink(href, text) {
    const value = `${href} ${text}`;
    return /(unsubscribe|退订|取消订阅|privacy|隐私政策|terms(?:\s+of\s+service)?|服务条款|facebook|instagram|linkedin|twitter|x\.com\/|youtube)/i.test(value);
  }

  function extractBody(bodyEl) {
    let clone;
    if (bodyEl instanceof HTMLIFrameElement) {
      try {
        clone = bodyEl.contentDocument?.body?.cloneNode(true);
      } catch {
        clone = null;
      }
    }
    clone ||= bodyEl.cloneNode(true);
    clone.querySelectorAll(`#${CARD_ID}, #${LEGACY_CARD_ID}, #${TRANSLATE_DOCK_ID}, #${TRANSLATE_TRIGGER_ID}, #${TASK_ORB_ID}`).forEach((element) => element.remove());
    clone.querySelectorAll(SELECTORS.cleanup).forEach((element) => element.remove());
    const text = clone.innerText || clone.textContent || "";
    return text
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 60000);
  }

  function ensureCard(thread) {
    let card = document.getElementById(CARD_ID);
    if (!card) {
      card = document.createElement("section");
      card.id = CARD_ID;
      card.className = "gais-card";
      card.setAttribute("aria-live", "polite");
    }
    placeCard(card, thread);
    return card;
  }

  function placeCard(card) {
    const subjectEl = findSubjectElement();
    const bodyEl = SITE.key === "outlook"
      ? findOutlookMessageBody() || findBodyElements()[0]
      : findBodyElements()[0];
    if (!subjectEl || !bodyEl) return;

    // Outlook 的三栏布局中，主题和邮件正文可能处在不同的列。必须只以真实的
    // messageBody/role=document 为锚点，将卡片放进正文滚动容器，而不能依据两者
    // 的共同外层 ReadingPaneContainerId（那会落到中间空白列）。
    if (SITE.key === "outlook") {
      const outlookBodyHost = bodyEl.parentElement;
      if (outlookBodyHost?.contains(bodyEl)) {
        if (card.parentElement !== outlookBodyHost || card.nextElementSibling !== bodyEl) {
          outlookBodyHost.insertBefore(card, bodyEl);
        }
        return;
      }
    }

    // 非 Gmail 邮箱的阅读区通常由正文容器直接承载。把卡片插到正文之前，
    // 避免被主题栏或邮箱外层布局拉到错误的位置。
    if (SITE.key !== "gmail") {
      const bodyHost = bodyEl.parentElement;
      if (bodyHost?.contains(bodyEl)) {
        if (card.parentElement !== bodyHost || card.nextElementSibling !== bodyEl) {
          bodyHost.insertBefore(card, bodyEl);
        }
        return;
      }
    }

    const messageRoot = findMessageRoot(bodyEl) || bodyEl;
    const common = findCommonAncestor(subjectEl, messageRoot);
    if (common && common !== document.body && common !== document.documentElement) {
      const subjectBranch = directChild(common, subjectEl);
      const messageBranch = directChild(common, messageRoot);
      if (subjectBranch && messageBranch && subjectBranch !== messageBranch) {
        if (card.parentElement !== common || card.nextElementSibling !== messageBranch) {
          common.insertBefore(card, messageBranch);
        }
        return;
      }
    }

    const fallbackRoot = messageRoot.closest(".h7") || messageRoot;
    fallbackRoot.parentElement?.insertBefore(card, fallbackRoot);
  }

  function renderLoading(card, thread, label = "正在自动分析邮件…") {
    removeTranslationControls();
    card.className = "gais-card gais-loading";
    card.innerHTML = `
      ${headerHtml(`AI 摘要 · ${SITE.label}`, thread, "")}
      <div class="gais-loading-row">
        <div class="gais-loading-copy">
          <strong>Otter 正在捕捉关键信息</strong>
          <span>${escapeHtml(label)}</span>
        </div>
        <canvas class="gais-shaping-orb" width="48" height="48" role="img" aria-label="AI 正在塑形摘要"></canvas>
      </div>
      <div class="gais-skeleton"><i></i><i></i><i></i></div>
    `;
    bindCommonActions(card);
    initShapingOrb(card.querySelector(".gais-shaping-orb"));
  }

  function renderSetup(card) {
    card.className = "gais-card gais-setup";
    card.innerHTML = `
      ${headerHtml(`AI 摘要 · ${SITE.label}`, null, "尚未配置")}
      <div class="gais-empty">
        <strong>配置一次，以后打开邮件就会自动出现摘要。</strong>
        <span>API Key 只保存在这个 Chrome 配置中，邮件直接发送给你选择的模型服务。</span>
        <button type="button" class="gais-primary" data-action="settings">打开设置</button>
      </div>
    `;
    bindCommonActions(card);
  }

  function renderError(card, message, thread, signature, settings) {
    card.className = "gais-card gais-error";
    card.innerHTML = `
      ${headerHtml(`AI 摘要 · ${SITE.label}`, thread, "生成失败")}
      <div class="gais-error-body">${escapeHtml(message)}</div>
      <div class="gais-actions">
        <button type="button" data-action="retry">重试</button>
        <button type="button" data-action="settings">检查设置</button>
      </div>
    `;
    bindCommonActions(card);
    card.querySelector('[data-action="retry"]')?.addEventListener("click", () => {
      generation += 1;
      generateBriefSummary(card, thread, signature, generation, settings, true);
    });
  }

  function renderBriefSummary(card, summary, thread, signature, myGeneration, settings, fromCache) {
    card.className = "gais-card gais-ready";
    const noReply = isNoReplySummary(summary, thread);
    // 首屏只保留一句结论和跟进回复；关键事实只在用户展开详细摘要后展示。
    const displaySummary = noReply
      ? { ...summary, keyFacts: [], actions: [], replyOptions: [] }
      : { ...summary, keyFacts: [] };
    const primaryAction = displaySummary.actions?.[0]?.text;
    const replyOptions = resolveReplyOptions(displaySummary, thread);
    const actionLinks = selectActionLinks(thread.links, displaySummary.summary);
    card._briefSummary = displaySummary;
    card._detailSummary = null;
    card._replyOptions = null;
    card._thread = thread;
    card._settings = settings;
    card._generation = myGeneration;

    card.innerHTML = `
      ${headerHtml(`AI 摘要 · ${SITE.label}`, thread, "", `
        <div class="gais-actions gais-header-actions" aria-label="摘要操作">
          <button type="button" class="gais-action-icon" data-action="copy" title="复制摘要" aria-label="复制摘要">${iconHtml("copy")}</button>
          <button type="button" class="gais-action-icon" data-action="refresh" title="重新生成摘要" aria-label="重新生成摘要">${iconHtml("refresh")}</button>
          <button type="button" class="gais-action-icon" data-action="settings" title="摘要设置" aria-label="摘要设置">${iconHtml("settings")}</button>
        </div>
      `)}
      <div class="gais-summary-row">
        <p class="gais-summary">${escapeHtml(displaySummary.summary)}</p>
      </div>
      <section class="gais-reply-panel" aria-live="polite" hidden></section>
      ${noReply ? '<div class="gais-no-reply" aria-label="无需回复">无需回复</div>' : ""}
      ${actionLinks.length ? `<nav class="gais-link-actions" aria-label="邮件操作"><span class="gais-link-actions-label">邮件操作</span><div>${actionLinks.map((link) => `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(link.title)}"><span>${escapeHtml(link.label)}</span><i aria-hidden="true">↗</i></a>`).join("")}</div></nav>` : ""}
      ${primaryAction ? `<div class="gais-action-preview"><span>待办</span><strong>${escapeHtml(primaryAction)}</strong><button type="button" class="gais-add-task" data-action="add-task" title="添加到 Otter 待办">+ 添加</button></div>` : ""}
      <div class="gais-footer">
        <span class="gais-copy-feedback" role="status" aria-live="polite"></span>
        <button type="button" class="gais-detail-toggle" data-action="details" aria-expanded="false" aria-label="展开详细总结" title="展开详细总结">
          <i aria-hidden="true">⌄</i>
        </button>
      </div>
      <div class="gais-detail-panel" aria-hidden="true"><div class="gais-details"></div></div>
    `;
    bindCommonActions(card);
    ensureTranslationControls(card, signature);
    if (replyOptions.length) renderReplyOptions(card, replyOptions);
    card.querySelector('[data-action="copy"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        await copyText(summaryToText(card._detailSummary || card._briefSummary));
        button.innerHTML = iconHtml("check");
        button.classList.add("gais-copy-success");
        showCopyFeedback(card, "已复制到剪贴板", false);
        setTimeout(() => {
          button.innerHTML = iconHtml("copy");
          button.classList.remove("gais-copy-success");
        }, 1600);
      } catch {
        button.innerHTML = iconHtml("alert");
        button.classList.add("gais-copy-failed");
        showCopyFeedback(card, "无法访问剪贴板", true);
        setTimeout(() => {
          button.innerHTML = iconHtml("copy");
          button.classList.remove("gais-copy-failed");
        }, 1600);
      }
    });
    card.querySelector('[data-action="details"]')?.addEventListener("click", () => {
      toggleDetailSummary(card);
    });
    card.querySelector('[data-action="add-task"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const action = displaySummary.actions?.[0];
      if (!button || !action) return;
      button.disabled = true;
      button.textContent = "添加中…";
      const previous = await sendMessage({ type: "GET_TASKS" });
      const previousIds = new Set((previous?.tasks || []).map((task) => task.id));
      const response = await sendMessage({
        type: "UPSERT_TASKS",
        payload: {
          emailKey: `${SITE.key}:${signature}`,
          source: "brief",
          providerLabel: SITE.label,
          subject: thread.subject,
          url: location.href,
          actions: [action]
        }
      });
      if (!response?.ok) {
        button.disabled = false;
        button.textContent = "重试添加";
        return;
      }
      const addedCount = (response.tasks || []).filter((task) => !previousIds.has(task.id)).length;
      renderTaskOrb(response.tasks || [], addedCount);
      button.textContent = addedCount ? "已添加" : "已在待办";
      button.classList.add("gais-add-task-done");
    });
    card.querySelector('[data-action="refresh"]')?.addEventListener("click", async () => {
      if (card._threadKey) briefResultsByThreadKey.delete(card._threadKey);
      await chrome.storage.local.remove([
        `${BRIEF_CACHE_PREFIX}${signature}`,
        `${DETAIL_CACHE_PREFIX}${signature}`,
        `${TRANSLATION_CACHE_PREFIX}${signature}`
      ]);
      generation += 1;
      generateBriefSummary(card, thread, signature, generation, settings, true);
    });
  }

  function renderReplyOptions(card, options) {
    const panel = card.querySelector(".gais-reply-panel");
    if (!panel) return;
    card._replyOptions = options;
    panel.hidden = false;
    panel.className = "gais-reply-panel gais-reply-panel-options";
    panel.innerHTML = `
      <span class="gais-reply-label">跟进回复 <small>选择一句生成草稿</small></span>
      <div class="gais-reply-options">
        ${options.map((option, index) => `
          <button type="button" class="gais-reply-option" data-reply-index="${index}">
            ${escapeHtml(option)}
          </button>
        `).join("")}
      </div>
    `;
    panel.addEventListener("click", (event) => {
      const button = event.target.closest(".gais-reply-option");
      if (!(button instanceof HTMLButtonElement) || !panel.contains(button) || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      const option = card._replyOptions?.[Number(button.dataset.replyIndex)];
      if (!option) return;
      panel.querySelectorAll(".gais-reply-option").forEach((item) => { item.disabled = true; });
      generateReplyDraft(card, option).catch((error) => {
        if (card.isConnected) renderReplyError(card, friendlyReplyError(error));
      });
    });
  }

  async function generateReplyDraft(card, option) {
    const panel = card.querySelector(".gais-reply-panel");
    if (!panel || !card._thread) return;
    card._selectedReplyOption = option;
    panel.hidden = false;
    panel.className = "gais-reply-panel gais-reply-panel-draft";
    panel.innerHTML = '<div class="gais-reply-loading"><span class="gais-spinner" aria-hidden="true"></span><span>正在生成回复内容…</span></div>';
    const requestGeneration = card._generation;
    let response;
    try {
      response = await sendMessage({
        type: "GENERATE_REPLY_DRAFT",
        payload: { thread: card._thread, option }
      });
    } catch (error) {
      if (card.isConnected && card._generation === requestGeneration) {
        renderReplyError(card, friendlyReplyError(error));
      }
      return;
    }
    if (!card.isConnected || card._generation !== requestGeneration) return;
    if (!response?.ok || !response.draft?.draft) {
      renderReplyError(card, response?.error || "回复内容生成失败");
      return;
    }
    renderReplyDraft(card, response.draft.draft);
  }

  function renderReplyDraft(card, draft) {
    const panel = card.querySelector(".gais-reply-panel");
    if (!panel) return;
    panel.hidden = false;
    panel.className = "gais-reply-panel gais-reply-panel-draft";
    panel.innerHTML = `
      <div class="gais-reply-heading"><strong>跟进回复草稿</strong><span>发送前请按实际情况确认</span></div>
      <textarea class="gais-reply-draft" aria-label="跟进回复草稿">${escapeHtml(draft)}</textarea>
      <div class="gais-reply-draft-actions">
        <button type="button" class="gais-action-icon" data-action="copy-reply" title="复制回复" aria-label="复制回复">${iconHtml("copy")}</button>
        <button type="button" class="gais-reply-change" data-action="cancel-reply-draft">取消</button>
      </div>
    `;
    panel.querySelector('[data-action="copy-reply"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const draftText = panel.querySelector(".gais-reply-draft")?.value || "";
      try {
        await copyText(draftText);
        button.innerHTML = iconHtml("check");
        setTimeout(() => { button.innerHTML = iconHtml("copy"); }, 1300);
      } catch {
        button.innerHTML = iconHtml("alert");
        setTimeout(() => { button.innerHTML = iconHtml("copy"); }, 1300);
      }
    });
    panel.querySelector('[data-action="cancel-reply-draft"]')?.addEventListener("click", () => {
      renderReplyOptions(card, card._replyOptions || []);
    });
  }

  function renderReplyError(card, message) {
    const panel = card.querySelector(".gais-reply-panel");
    if (!panel) return;
    panel.hidden = false;
    panel.className = "gais-reply-panel gais-reply-panel-draft";
    panel.innerHTML = `<div class="gais-reply-error">${escapeHtml(message)} <button type="button" data-action="retry-reply-draft">重试</button></div>`;
    panel.querySelector('[data-action="retry-reply-draft"]')?.addEventListener("click", () => {
      if (card._selectedReplyOption) generateReplyDraft(card, card._selectedReplyOption);
    });
  }

  function ensureTranslationControls(card, signature) {
    if (!card?._thread || !card?._settings) return;
    const existingTrigger = document.getElementById(TRANSLATE_TRIGGER_ID);
    const existingDock = document.getElementById(TRANSLATE_DOCK_ID);
    if (existingTrigger?.isConnected && existingDock?.isConnected && card._translationSignature === signature) {
      card._translationTrigger = existingTrigger;
      card._translationPanel = existingDock.querySelector(".gais-translation-panel");
      return;
    }

    removeTranslationControls();
    const bodyEl = SITE.key === "outlook"
      ? findOutlookMessageBody() || findBodyElements()[0]
      : findBodyElements()[0];
    if (!bodyEl?.parentElement) return;

    const trigger = document.createElement("button");
    trigger.id = TRANSLATE_TRIGGER_ID;
    trigger.type = "button";
    trigger.className = "gais-external-translate-trigger";
    trigger.title = "将当前邮件全文翻译为简体中文";
    trigger.innerHTML = '<span aria-hidden="true">译</span><strong>使用 Otter 翻译为简体中文</strong>';

    const dock = document.createElement("section");
    dock.id = TRANSLATE_DOCK_ID;
    dock.className = `gais-translate-dock gais-translate-dock-${SITE.key}`;
    dock.setAttribute("aria-live", "polite");
    const panel = document.createElement("div");
    panel.className = "gais-translation-panel";
    panel.hidden = true;

    if (SITE.key === "gmail") {
      const nativeSummary = findGmailNativeSummaryButton();
      if (nativeSummary?.parentElement) nativeSummary.insertAdjacentElement("afterend", trigger);
      else dock.append(trigger);
      dock.append(panel);
    } else {
      dock.append(trigger, panel);
    }
    bodyEl.insertAdjacentElement("afterend", dock);

    card._translationTrigger = trigger;
    card._translationPanel = panel;
    card._translationSignature = signature;
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      translateThread(card, signature);
    });
  }

  function findGmailNativeSummaryButton() {
    return visibleElements(document.querySelectorAll('button, [role="button"]'))
      .find((element) => {
        if (element.id === TRANSLATE_TRIGGER_ID || element.closest(`#${CARD_ID}`)) return false;
        const text = (element.innerText || element.textContent || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        return /总结此邮件|summari[sz]e this email/i.test(text);
      }) || null;
  }

  function removeTranslationControls() {
    document.getElementById(TRANSLATE_TRIGGER_ID)?.remove();
    document.getElementById(TRANSLATE_DOCK_ID)?.remove();
  }

  async function translateThread(card, signature) {
    const panel = card._translationPanel;
    const trigger = card._translationTrigger;
    const thread = card._thread;
    const settings = card._settings;
    if (!panel || !trigger || !thread || !settings || trigger.disabled) return;

    const cacheKey = `${TRANSLATION_CACHE_PREFIX}${signature}`;
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]?.translation) {
      renderTranslation(card, cached[cacheKey].translation);
      return;
    }
    if (!settings.apiKey) {
      renderTranslationError(card, "请先在设置中填写 API Key");
      return;
    }

    trigger.disabled = true;
    trigger.classList.add("gais-translate-busy");
    renderTranslationLoading(card);
    const requestGeneration = card._generation;
    const response = await sendMessage({ type: "TRANSLATE_EMAIL", payload: thread });
    if (!card.isConnected || card._generation !== requestGeneration) return;
    trigger.disabled = false;
    trigger.classList.remove("gais-translate-busy");
    if (!response?.ok || !response.translation?.translation) {
      renderTranslationError(card, response?.error || "全文翻译失败，请重试");
      return;
    }
    await chrome.storage.local.set({
      [cacheKey]: { translation: response.translation.translation, createdAt: Date.now() }
    });
    pruneCache().catch(() => {});
    renderTranslation(card, response.translation.translation);
  }

  function renderTranslationLoading(card) {
    const panel = card._translationPanel;
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = '<div class="gais-translation-loading"><span class="gais-spinner" aria-hidden="true"></span><span>正在翻译当前邮件全文…</span></div>';
  }

  function renderTranslation(card, translation) {
    const panel = card._translationPanel;
    const trigger = card._translationTrigger;
    if (!panel || !trigger) return;
    trigger.classList.add("gais-translate-ready");
    panel.hidden = false;
    panel.innerHTML = `
      <div class="gais-translation-heading">
        <div><strong>全文译文</strong><span>简体中文 · 原文仍保留在下方</span></div>
        <div class="gais-translation-actions">
          <button type="button" class="gais-action-icon" data-action="copy-translation" title="复制全文译文" aria-label="复制全文译文">${iconHtml("copy")}</button>
          <button type="button" class="gais-translation-close" data-action="close-translation">收起</button>
        </div>
      </div>
      <div class="gais-translation-content" tabindex="0">${escapeHtml(translation)}</div>
    `;
    panel.querySelector('[data-action="copy-translation"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        await copyText(translation);
        button.innerHTML = iconHtml("check");
        setTimeout(() => { button.innerHTML = iconHtml("copy"); }, 1300);
      } catch {
        button.innerHTML = iconHtml("alert");
        setTimeout(() => { button.innerHTML = iconHtml("copy"); }, 1300);
      }
    });
    panel.querySelector('[data-action="close-translation"]')?.addEventListener("click", () => {
      panel.hidden = true;
    });
  }

  function renderTranslationError(card, message) {
    const panel = card._translationPanel;
    const trigger = card._translationTrigger;
    if (!panel || !trigger) return;
    trigger.disabled = false;
    trigger.classList.remove("gais-translate-busy");
    panel.hidden = false;
    panel.innerHTML = `<div class="gais-translation-error">${escapeHtml(message)} <button type="button" data-action="retry-translation">重试</button></div>`;
    panel.querySelector('[data-action="retry-translation"]')?.addEventListener("click", () => {
      translateThread(card, card.dataset.signature);
    });
  }

  function resolveReplyOptions(summary, thread) {
    const supplied = Array.isArray(summary.replyOptions)
      ? summary.replyOptions.map((option) => String(option || "").trim()).filter(Boolean).slice(0, 3)
      : [];
    if (isNoReplySummary(summary, thread)) return [];
    if (supplied.length) return supplied;

    const context = [summary.summary, ...(summary.keyFacts || [])].join(" ");
    if (!/(请|需|需要|确认|是否|能否|可否|下一步|对接|支持|要求|问题|follow\s*up|next\s*step|confirm|need|require|could|would|\?|？)/i.test(context)) {
      return [];
    }

    const options = [];
    if (/美国实体|实体要求|\bentity\b/i.test(context)) options.push("确认实体资质要求");
    if (/聚合商|aggregator/i.test(context)) options.push("请提供支持聚合商清单");
    if (/Plaid|MX|Yodlee/i.test(context)) options.push("确认 Plaid 等是否支持");
    options.push("请说明下一步对接方式", "请补充具体要求与时间");
    return [...new Set(options)].slice(0, 3);
  }

  function selectActionLinks(links, summaryText) {
    if (!Array.isArray(links)) return [];
    const summary = String(summaryText || "").toLowerCase();
    return links
      .map((link) => {
        let host = "";
        try { host = new URL(link.href).hostname.toLowerCase(); } catch { return null; }
        const text = String(link.text || "").trim();
        let label = actionLinkLabel(host, link.href, text);
        let score = 0;
        if (/appstoreconnect\.apple\.com$/.test(host)) {
          label = "前往 App Store Connect";
          score += 200;
        } else if (/testflight\.apple\.com$/.test(host)) {
          label = "前往 TestFlight";
          score += 180;
        } else if (/reportaproblem\.apple\.com$/.test(host)) {
          score += 170;
        } else if (/(^|\.)account\.apple\.com$|appleid\.apple\.com$|idmsa\.apple\.com$/.test(host)) {
          score += 160;
        } else if (/apps\.apple\.com$|support\.apple\.com$/.test(host)) {
          score += 140;
        } else if (/(查看|详情|处理|审核|报告|账户|控制台|dashboard|review|details|manage|console|report|account|verify|confirm)/i.test(text)) {
          score += 70;
        }
        if (summary.includes(host.replace(/^www\./, ""))) score += 50;
        if (/(app store connect|testflight|查看详情|前往|处理)/i.test(`${summary} ${text}`)) score += 25;
        if (!text && score < 100) return null;
        return { href: link.href, label, title: text || host, score };
      })
      .filter((item) => item && item.score >= 50)
      .sort((a, b) => b.score - a.score)
      .filter((item, index, list) => list.findIndex((other) => other.label === item.label) === index)
      .slice(0, 2);
  }

  function actionLinkLabel(host, href, text) {
    const normalizedText = String(text || "").trim();
    let path = "";
    try { path = new URL(href).pathname.toLowerCase(); } catch { /* 已由调用方校验 URL */ }

    if (/appstoreconnect\.apple\.com$/.test(host)) return "前往 App Store Connect";
    if (/testflight\.apple\.com$/.test(host)) return "前往 TestFlight";
    if (/reportaproblem\.apple\.com$/.test(host)) return "报告购买问题";
    if (/(^|\.)account\.apple\.com$|appleid\.apple\.com$|idmsa\.apple\.com$/.test(host)) return "进入 Apple 账户";
    if (/apps\.apple\.com$/.test(host)) return "在 App Store 中查看";
    if (/support\.apple\.com$/.test(host)) return "获取 Apple 支持";

    if (/^(apple\s*(id|账户|账号)|账户|账号)$/i.test(normalizedText)) return "进入 Apple 账户";
    if (/^(报告问题|report (a )?problem)$/i.test(normalizedText) || /report.*problem/.test(path)) return "报告问题";
    if (/^(查看详情|details?|learn more)$/i.test(normalizedText)) return "查看邮件详情";
    return normalizedText && normalizedText.length <= 36 ? normalizedText : "查看邮件详情";
  }

  function hasExplicitNoReplySignal(thread) {
    const latest = thread?.messages?.at?.(-1);
    const text = [thread?.subject, latest?.sender, latest?.body].filter(Boolean).join(" ");
    return /无需回复|请勿回复|不需要回复|请不要回复|do\s*not\s*reply|no\s*reply(?:\s*needed)?|noreply|no-reply|自动(?:发送|通知)/i.test(text);
  }

  function isNoReplySummary(summary, thread) {
    return summary?.replyNeeded === false || hasExplicitNoReplySignal(thread);
  }

  function friendlyReplyError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return message || "回复内容生成失败，请重试";
  }

  async function toggleDetailSummary(card) {
    if (card.classList.contains("gais-details-open")) {
      setDetailExpanded(card, false);
      return;
    }
    await openDetailSummary(card);
  }

  async function openDetailSummary(card) {
    const { _thread: thread, _briefSummary: brief, _settings: settings, _generation: myGeneration } = card;
    const signature = card.dataset.signature;
    if (!thread || !brief || !settings || !signature) return;

    setDetailExpanded(card, true);
    if (card._detailSummary) return;
    renderDetailLoading(card);

    const cacheKey = `${DETAIL_CACHE_PREFIX}${signature}`;
    const cached = await chrome.storage.local.get(cacheKey);
    if (myGeneration !== generation || card.dataset.signature !== signature) return;
    if (cached[cacheKey]?.summary) {
      renderDetailSummary(card, cached[cacheKey].summary);
      return;
    }
    if (!settings.apiKey) {
      renderDetailError(card, "请先在设置中填写 API Key");
      return;
    }

    const response = await sendMessage({ type: "SUMMARIZE_DETAIL", payload: thread });
    if (myGeneration !== generation || card.dataset.signature !== signature) return;
    if (!response?.ok) {
      renderDetailError(card, response?.error || "详细摘要生成失败");
      return;
    }
    await chrome.storage.local.set({
      [cacheKey]: { summary: response.summary, createdAt: Date.now() }
    });
    pruneCache().catch(() => {});
    renderDetailSummary(card, response.summary);
  }

  function setDetailExpanded(card, expanded) {
    card.classList.toggle("gais-details-open", expanded);
    card.querySelector(".gais-detail-panel")?.setAttribute("aria-hidden", String(!expanded));
    const toggle = card.querySelector('[data-action="details"]');
    if (!toggle) return;
    toggle.setAttribute("aria-expanded", String(expanded));
    const label = expanded ? "收起详细总结" : "展开详细总结";
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
  }

  function renderDetailLoading(card) {
    const details = card.querySelector(".gais-details");
    if (!details) return;
    details.innerHTML = `
      <div class="gais-detail-loading"><span class="gais-spinner" aria-hidden="true"></span><span>正在生成详细总结…</span></div>
      <div class="gais-detail-skeleton"><i></i><i></i><i></i></div>
    `;
  }

  function renderDetailSummary(card, summary) {
    const details = card.querySelector(".gais-details");
    if (!details) return;
    const noReply = isNoReplySummary(card._briefSummary, card._thread);
    const keyPoints = summary.keyPoints?.length
      ? sectionHtml("关键点", `<ul>${summary.keyPoints.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`, "points")
      : "";
    const actions = !noReply && summary.actions?.length
      ? sectionHtml("待办", `<div class="gais-task-list">${summary.actions.map((item) => `
          <div class="gais-task"><span class="gais-check"></span><div><b>${escapeHtml(item.text)}</b></div></div>
        `).join("")}</div>`, "actions")
      : "";
    const deadlines = summary.deadlines?.length
      ? sectionHtml("时间与期限", `<ul>${summary.deadlines.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`, "deadlines")
      : "";
    details.innerHTML = `
      <p class="gais-detail-summary">${escapeHtml(summary.detail)}</p>
      ${keyPoints}${actions}${deadlines}
    `;
    card._detailSummary = noReply ? { ...summary, actions: [] } : summary;
    if (!noReply) syncTasks(card._thread, summary, card.dataset.signature, "detail").catch(() => {});
  }

  function renderDetailError(card, message) {
    const details = card.querySelector(".gais-details");
    if (!details) return;
    details.innerHTML = `<div class="gais-detail-error">${escapeHtml(message)} <button type="button" data-action="retry-detail">重试</button></div>`;
    details.querySelector('[data-action="retry-detail"]')?.addEventListener("click", () => openDetailSummary(card));
  }

  function headerHtml(title, _thread, _status, headerActions = "") {
    return `
      <div class="gais-header">
        <div class="gais-brand">
          <span class="gais-brand-otter" aria-hidden="true"><img src="${escapeHtml(assetUrl("otter_orb.png"))}" alt=""></span>
          <span class="gais-brand-copy"><small>Email Otter</small><strong>${escapeHtml(title)}</strong></span>
          ${headerActions}
        </div>
        <div class="gais-header-right">
          <button type="button" class="gais-icon-button" data-action="collapse" title="折叠/展开" aria-label="折叠或展开摘要">⌃</button>
        </div>
      </div>
    `;
  }

  function iconHtml(name) {
    const icons = {
      copy: "assets/icons/lucide-copy.svg",
      refresh: "assets/icons/lucide-refresh-cw.svg",
      settings: "assets/icons/lucide-settings.svg",
      check: "assets/icons/lucide-check.svg",
      alert: "assets/icons/lucide-triangle-alert.svg"
    };
    const asset = icons[name];
    return asset ? `<img class="gais-lucide-icon" src="${escapeHtml(assetUrl(asset))}" alt="">` : "";
  }

  // Agent Shaping：以均匀点阵在圆形、三角形、方形之间平滑过渡。
  // 使用原生 2D Canvas，不向邮箱页面引入第三方脚本或网络请求。
  function initShapingOrb(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const size = 48;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

    const circle = (f) => {
      const angle = -Math.PI / 2 + f * Math.PI * 2;
      return [Math.cos(angle) * .31, Math.sin(angle) * .31];
    };
    const polygon = (vertices, f) => {
      const lengths = vertices.map((point, index) => {
        const next = vertices[(index + 1) % vertices.length];
        return Math.hypot(next[0] - point[0], next[1] - point[1]);
      });
      const perimeter = lengths.reduce((sum, length) => sum + length, 0);
      let target = f * perimeter;
      for (let index = 0; index < vertices.length; index += 1) {
        if (target <= lengths[index] || index === vertices.length - 1) {
          const start = vertices[index];
          const end = vertices[(index + 1) % vertices.length];
          const progress = lengths[index] ? target / lengths[index] : 0;
          return [
            start[0] + (end[0] - start[0]) * progress,
            start[1] + (end[1] - start[1]) * progress
          ];
        }
        target -= lengths[index];
      }
      return vertices[0];
    };
    const shapes = [
      circle,
      (f) => polygon([[0, -.34], [.3, .2], [-.3, .2]], f),
      (f) => polygon([[0, -.27], [.27, -.27], [.27, .27], [-.27, .27], [-.27, -.27]], f)
    ];
    const ease = (value) => value * value * (3 - 2 * value);
    const draw = (seconds) => {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, size, size);
      const hold = 1.05;
      const morph = .8;
      const segment = hold + morph;
      const cycle = segment * shapes.length;
      const elapsed = seconds % cycle;
      const index = Math.floor(elapsed / segment);
      const local = elapsed - index * segment;
      const amount = local > hold ? ease((local - hold) / morph) : 0;
      const current = shapes[index];
      const next = shapes[(index + 1) % shapes.length];
      const pulse = 1 + Math.sin(seconds * 3.2) * .025;
      for (let dot = 0; dot < 18; dot += 1) {
        const f = dot / 18;
        const a = current(f);
        const b = next(f);
        const x = (a[0] + (b[0] - a[0]) * amount) * pulse;
        const y = (a[1] + (b[1] - a[1]) * amount) * pulse;
        const radius = dot % 3 === 0 ? 1.55 : 1.2;
        context.beginPath();
        context.fillStyle = `rgba(16, 93, 119, ${.5 + (dot % 4) * .12})`;
        context.arc(size / 2 + x * size, size / 2 + y * size, radius, 0, Math.PI * 2);
        context.fill();
      }
    };
    const start = performance.now();
    const loop = (now) => {
      draw((now - start) / 1000);
      if (canvas.isConnected && !document.hidden) requestAnimationFrame(loop);
    };
    draw(.6);
    if (!prefersReducedMotion) requestAnimationFrame(loop);
  }

  function sectionHtml(title, body, className) {
    return `<section class="gais-section gais-${className}"><h4>${escapeHtml(title)}</h4>${body}</section>`;
  }

  function bindCommonActions(card) {
    bindCardInteractionIsolation(card);
    card.querySelector('[data-action="settings"]')?.addEventListener("click", () => {
      sendMessage({ type: "OPEN_OPTIONS" });
    });
    card.querySelector('[data-action="collapse"]')?.addEventListener("click", (event) => {
      const collapsed = card.classList.toggle("gais-collapsed");
      event.currentTarget.textContent = collapsed ? "⌄" : "⌃";
    });
  }

  function bindCardInteractionIsolation(card) {
    if (card._gaisInteractionIsolationBound) return;
    card._gaisInteractionIsolationBound = true;

    const shouldIsolate = (target) => {
      const element = target instanceof Element ? target : target?.parentElement;
      return Boolean(element?.closest("button, textarea, input, select, a") && card.contains(element));
    };
    const stopPointer = (event) => {
      if (shouldIsolate(event.target)) event.stopPropagation();
    };
    ["pointerdown", "pointerup", "mousedown", "mouseup", "auxclick", "dblclick", "contextmenu"].forEach((type) => {
      card.addEventListener(type, stopPointer, true);
    });
    card.addEventListener("click", (event) => {
      if (shouldIsolate(event.target)) event.stopPropagation();
    });
    card.addEventListener("keydown", (event) => {
      if (shouldIsolate(event.target)) event.stopPropagation();
    }, true);
  }

  function findMessageRoot(element) {
    for (const selector of SELECTORS.messageRoot.split(",")) {
      const root = element.closest(selector.trim());
      if (root) return root;
    }
    return element.parentElement;
  }

  function findSubjectElement() {
    for (const selector of selectorParts(SELECTORS.subject)) {
      const candidates = visibleElements(document.querySelectorAll(selector))
        .filter((element) => isLikelySubject(element));
      if (candidates.length) return candidates.at(-1);
    }
    if (SITE.key === "qq") return findQQSubjectFallback();
    if (SITE.key === "outlook") return findOutlookSubjectFallback();
    if (["yahoo", "icloud", "mail163"].includes(SITE.key)) return findGenericSubjectFallback();
    return null;
  }

  function findBodyElements() {
    // Outlook 的垃圾邮件阅读页会先渲染系统提示条，普通正文选择器可能会把提示条
    // 当成正文。此时优先使用从主题下方寻找真实内容块的兜底逻辑。
    if (SITE.key === "outlook" && isJunkMailRoute()) {
      const junkFallback = findOutlookBodyFallback();
      if (junkFallback.length) return junkFallback;
    }
    let deferredFrames = [];
    for (const selector of selectorParts(SELECTORS.bodies)) {
      const candidates = visibleElements(document.querySelectorAll(selector))
        .filter((element) => isLikelyBody(element));
      if (SITE.key !== "gmail" && selector === "iframe") {
        deferredFrames = candidates;
        continue;
      }
      if (candidates.length) return candidates;
    }
    if (SITE.key === "qq") {
      const fallback = findQQBodyFallback();
      return fallback.length ? fallback : deferredFrames;
    }
    if (SITE.key === "outlook") {
      const fallback = findOutlookBodyFallback();
      return fallback.length ? fallback : deferredFrames;
    }
    if (["yahoo", "icloud", "mail163"].includes(SITE.key)) {
      const fallback = findGenericBodyFallback();
      return fallback.length ? fallback : deferredFrames;
    }
    return [];
  }

  function findGenericSubjectFallback() {
    const candidates = visibleElements(document.querySelectorAll("h1, h2, h3, div, span"))
      .map((element) => {
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const fontSize = Number.parseFloat(style.fontSize) || 0;
        if (!isLikelySubject(element) || text.length < 2 || text.length > 220 || rect.width < 140 || rect.top < 30 || rect.top > 420 || fontSize < 16) {
          return null;
        }
        const marker = `${element.id} ${element.className} ${element.getAttribute("data-testid") || ""} ${element.getAttribute("aria-label") || ""}`;
        const headingBonus = element.matches("h1, h2, h3") ? 140 : 0;
        const subjectBonus = /(subject|title|message)/i.test(marker) ? 180 : 0;
        return { element, score: headingBonus + subjectBonus + fontSize * 10 - rect.top / 1000 - text.length / 100 };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  function findGenericBodyFallback() {
    const subjectEl = findSubjectElement();
    if (!subjectEl) return [];
    const subjectRect = subjectEl.getBoundingClientRect();
    const candidates = visibleElements(document.querySelectorAll("article, [role=article], main, section, div, td, p"))
      .map((element) => {
        if (element.id === CARD_ID || element.closest(`#${CARD_ID}`) || element.contains(subjectEl) || subjectEl.contains(element)) return null;
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const rect = element.getBoundingClientRect();
        if (text.length < 60 || rect.width < 280 || rect.height < 36 || rect.top < subjectRect.bottom - 4) return null;
        const marker = `${element.id} ${element.className} ${element.getAttribute("role") || ""} ${element.getAttribute("aria-label") || ""}`;
        const structuralBonus = /(mail|letter|body|content|read|detail|message|article)/i.test(marker) ? 100 : 0;
        const readableLength = Math.min(text.length, 6000) / 120;
        const distancePenalty = Math.min(Math.max(0, rect.top - subjectRect.bottom) / 350, 20);
        return { element, score: structuralBonus + readableLength + elementPathDepth(element) - distancePenalty };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return candidates.length ? [candidates[0].element] : [];
  }

  function findOutlookSubjectFallback() {
    const candidates = visibleElements(document.querySelectorAll("div, span"))
      .map((element) => {
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const fontSize = Number.parseFloat(style.fontSize) || 0;
        const minimumTop = isJunkMailRoute() ? 0 : 40;
        if (!isLikelySubject(element) || text.length < 2 || rect.width < 160 || rect.top < minimumTop || rect.top > 380 || fontSize < 18) {
          return null;
        }
        const marker = `${element.id} ${element.className} ${element.getAttribute("aria-label") || ""}`;
        const subjectBonus = /(subject|title)/i.test(marker) ? 200 : 0;
        return { element, score: subjectBonus + fontSize * 10 - rect.top / 1000 };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  // Outlook 会在不同账户和邮件类型中切换阅读组件。稳定属性不存在时，正文仍会
  // 位于主题下方的独立可见块中；以位置、文本和容器标记共同选择该块。
  function findOutlookBodyFallback() {
    const subjectEl = findSubjectElement();
    if (!subjectEl) return [];
    const subjectRect = subjectEl.getBoundingClientRect();
    const candidates = visibleElements(document.querySelectorAll("article, [role=article], main, [role=main], section, div, td, p"))
      .map((element) => {
        if (element.contains(subjectEl) || subjectEl.contains(element)) return null;
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const rect = element.getBoundingClientRect();
        if (text.length < 60 || rect.width < 280 || rect.height < 36 || rect.top < subjectRect.bottom - 4) return null;
        const marker = `${element.id} ${element.className} ${element.getAttribute("role") || ""} ${element.getAttribute("aria-label") || ""}`;
        if (element.matches("[role=alert], [aria-live]")) return null;
        if (isOutlookJunkNotice(text, marker)) return null;
        const structuralBonus = /(mail|letter|body|content|read|detail|message|article)/i.test(marker) ? 100 : 0;
        const readableLength = Math.min(text.length, 6000) / 120;
        const distancePenalty = Math.min(Math.max(0, rect.top - subjectRect.bottom) / 350, 20);
        return { element, score: structuralBonus + readableLength + elementPathDepth(element) - distancePenalty };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return candidates.length ? [candidates[0].element] : [];
  }

  // Outlook 当前版本会为真实邮件正文提供语义化的 role/aria/id；这些标记比
  // 位置推断稳定得多。优先只选这一类元素，避免把分栏布局中的空白容器误当正文。
  function findOutlookMessageBody() {
    const selectors = [
      '[data-automation-id="messageBody"]',
      '[data-automation-id*="messagebody" i]',
      '[data-automationid*="messagebody" i]',
      '[aria-label="Message body"]',
      '[aria-label*="message body" i]',
      '[aria-label*="邮件正文"]',
      '[id*="messagebody" i]',
      '[role="document"]'
    ];
    const candidates = visibleElements(document.querySelectorAll(selectors.join(",")))
      .filter((element) => {
        if (element.id === CARD_ID || element.closest(`#${CARD_ID}`)) return false;
        const text = (element.innerText || element.textContent || "").trim();
        return text.length >= 20 && !isOutlookJunkNotice(text, `${element.id} ${element.className} ${element.getAttribute("aria-label") || ""}`);
      })
      .map((element) => {
        const marker = `${element.id} ${element.className} ${element.getAttribute("role") || ""} ${element.getAttribute("aria-label") || ""}`;
        const rect = element.getBoundingClientRect();
        const semanticScore = /messagebody|message body|邮件正文|role=document/i.test(marker) ? 10000 : 0;
        return { element, score: semanticScore + Math.min((element.innerText || "").length, 10000) / 10 + Math.min(rect.height, 4000) / 100 };
      })
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  // 新版 QQ 邮箱有时只使用无语义的 div 来渲染主题。标题通常与带邮箱地址的
  // 发件人信息相邻，且字体明显大于正文；这两个特征可作为最后一层定位依据。
  function findQQSubjectFallback() {
    const candidates = visibleElements(document.querySelectorAll("div, span"))
      .map((element) => {
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const rect = element.getBoundingClientRect();
        const fontSize = Number.parseFloat(getComputedStyle(element).fontSize) || 0;
        if (!isLikelySubject(element) || text.length < 2 || rect.width < 140 || rect.top < 100 || fontSize < 18) {
          return null;
        }

        let hasSenderContext = false;
        for (let current = element; current && !hasSenderContext; current = current.parentElement) {
          hasSenderContext = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(current.innerText || current.textContent || "");
          if (current === document.body || elementPathDepth(current) + 4 < elementPathDepth(element)) break;
        }
        if (!hasSenderContext) return null;
        return { element, score: fontSize * 10 + Math.min(text.length, 160) / 10 - rect.top / 10000 };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  // QQ 邮箱新版阅读页会不定期更换 class，邮件正文也不总在 iframe 中。
  // 当稳定选择器没有命中时，从主题下方选取最像正文的可见块作为兜底。
  function findQQBodyFallback() {
    const subjectEl = findSubjectElement();
    if (!subjectEl) return [];
    const subjectRect = subjectEl.getBoundingClientRect();
    const candidates = visibleElements(document.querySelectorAll("article, main, section, div, td, p"))
      .map((element) => {
        if (element.contains(subjectEl) || subjectEl.contains(element)) return null;
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const rect = element.getBoundingClientRect();
        if (
          text.length < 60 ||
          rect.width < 280 ||
          rect.height < 30 ||
          rect.top < subjectRect.bottom - 4
        ) return null;

        const marker = `${element.id} ${element.className} ${element.getAttribute("role") || ""}`;
        const structuralBonus = /(mail|letter|body|content|read|detail|message)/i.test(marker) ? 100 : 0;
        const readableLength = Math.min(text.length, 5000) / 100;
        const depth = elementPathDepth(element);
        const distancePenalty = Math.min(Math.max(0, rect.top - subjectRect.bottom) / 300, 20);
        return { element, score: structuralBonus + readableLength + depth - distancePenalty };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return candidates.length ? [candidates[0].element] : [];
  }

  // QQ 邮箱的列表页也包含 subject/title/content 等通用 class，且整个邮件表格
  // 文本很长，宽松选择器会把列表误判成一封邮件。只有主题附近存在明确发件人
  // 邮箱地址，并且候选正文不是带大量勾选框的邮件列表时，才视为阅读页。
  function isQQReadingView(subjectEl, bodyElements) {
    const subject = (subjectEl.innerText || subjectEl.textContent || "").replace(/\s+/g, " ").trim();
    if (!subject || /^(收件箱|星标邮件|重要联系人|群邮件|已发送|草稿箱|已删除|垃圾箱|我的文件夹|更早|本月)$/i.test(subject)) {
      return false;
    }

    const subjectRect = subjectEl.getBoundingClientRect();
    if (subjectRect.top < 80) return false;

    let senderNearby = visibleElements(document.querySelectorAll(SELECTORS.sender))
      .some((element) => {
        const identity = [
          element.getAttribute("email"),
          element.getAttribute("title"),
          element.getAttribute("href"),
          element.innerText,
          element.textContent
        ].filter(Boolean).join(" ");
        if (!/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(identity)) return false;
        const rect = element.getBoundingClientRect();
        return rect.top >= subjectRect.top - 40 && rect.top <= subjectRect.bottom + 280;
      });
    // QQ 新版有些邮件把发件人地址渲染成没有语义 class、title 或 mailto 的普通文本。
    // 只在主题附近寻找尺寸较小的邮箱文本节点，避免重新把列表页整行误判成阅读页。
    if (!senderNearby) {
      senderNearby = visibleElements(document.querySelectorAll("div, span, a"))
        .some((element) => {
          const identity = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
          if (identity.length < 5 || identity.length > 240 || !/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(identity)) return false;
          if (element.querySelectorAll?.('input[type="checkbox"], [role="checkbox"]').length) return false;
          const rect = element.getBoundingClientRect();
          return (
            rect.width >= 40 &&
            rect.width <= Math.max(720, subjectRect.width * 1.5) &&
            rect.height > 0 &&
            rect.height <= 120 &&
            rect.top >= subjectRect.top - 50 &&
            rect.top <= subjectRect.bottom + 300
          );
        });
    }
    if (!senderNearby) return false;

    return bodyElements.some((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.top < subjectRect.bottom - 4) return false;
      try {
        return element.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length < 3;
      } catch {
        return true;
      }
    });
  }

  function elementPathDepth(element) {
    let depth = 0;
    for (let current = element; current?.parentElement; current = current.parentElement) depth += 1;
    return depth;
  }

  function selectorParts(selectors) {
    return selectors.split(",").map((selector) => selector.trim()).filter(Boolean);
  }

  function isLikelySubject(element) {
    const text = (element.innerText || element.textContent || "").trim();
    if (!text || text.length > 300) return false;
    return !/^(收件箱|Inbox|星标邮件|Starred|草稿箱|Drafts|已发送|Sent|通讯录|Contacts|写信|Compose|垃圾邮件|Junk Email|Junk|Spam|已计划|Scheduled)$/i.test(text);
  }

  function isLikelyBody(element) {
    if (element instanceof HTMLIFrameElement) {
      const marker = `${element.id} ${element.name} ${element.className}`;
      if (/(mail|content|body|message|editor|main)/i.test(marker)) return true;
      try {
        return ((element.contentDocument?.body?.innerText || "").trim().length >= 20);
      } catch {
        return false;
      }
    }
    const text = (element.innerText || element.textContent || "").trim();
    if (SITE.key === "outlook" && (element.matches("[role=alert], [aria-live]") || isOutlookJunkNotice(text, `${element.id} ${element.className} ${element.getAttribute("aria-label") || ""}`))) {
      return false;
    }
    return text.length >= 2;
  }

  function isJunkMailRoute() {
    const route = `${location.pathname}${location.hash}${location.search}`;
    return /junk|spam|junkemail|垃圾邮件/i.test(route);
  }

  function isOutlookJunkNotice(text, marker = "") {
    const compact = `${marker} ${text}`.replace(/\s+/g, " ").trim();
    return /(identified as junk|not junk|blocked content|enable links|垃圾邮件.*删除|此邮件被识别为垃圾邮件|显示已阻止的内容|启用链接)/i.test(compact) && compact.length < 800;
  }

  function summaryToText(summary) {
    const lines = [summary.detail || summary.summary];
    if (summary.keyFacts?.length) lines.push("", "关键事实：", ...summary.keyFacts.map((item) => `- ${item}`));
    if (summary.keyPoints?.length) lines.push("", "关键点：", ...summary.keyPoints.map((item) => `- ${item}`));
    if (summary.actions?.length) lines.push("", "待办：", ...summary.actions.map((item) => `- ${item.text}`));
    if (summary.deadlines?.length) lines.push("", "时间与期限：", ...summary.deadlines.map((item) => `- ${item}`));
    return lines.join("\n");
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard unavailable");
  }

  function showCopyFeedback(card, message, isError) {
    const feedback = card.querySelector(".gais-copy-feedback");
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle("gais-copy-feedback-error", isError);
    clearTimeout(feedback._gaisTimer);
    feedback._gaisTimer = setTimeout(() => {
      feedback.textContent = "";
      feedback.classList.remove("gais-copy-feedback-error");
    }, 1800);
  }

  async function syncTasks(thread, summary, signature, source) {
    if (!thread || !signature || !Array.isArray(summary?.actions) || isNoReplySummary(summary, thread)) return;
    const response = await sendMessage({
      type: "UPSERT_TASKS",
      payload: {
        emailKey: `${SITE.key}:${signature}`,
        source,
        providerLabel: SITE.label,
        subject: thread.subject,
        url: location.href,
        actions: summary.actions
      }
    });
    if (response?.ok) renderTaskOrb(response.tasks || []);
  }

  async function refreshTaskOrb() {
    if (!extensionAvailable()) return;
    const response = await sendMessage({ type: "GET_TASKS" });
    if (response?.ok) renderTaskOrb(response.tasks || []);
  }

  function ensureTaskOrb() {
    let orb = document.getElementById(TASK_ORB_ID);
    if (orb) return orb;

    orb = document.createElement("aside");
    orb.id = TASK_ORB_ID;
    orb.className = "gais-task-orb";
    orb.innerHTML = `
      <button type="button" class="gais-orb-trigger" aria-label="查看全部待办" aria-expanded="false" title="查看全部待办">
        <span class="gais-orb-logo" aria-hidden="true"><img alt=""></span>
        <span class="gais-orb-count" hidden>0</span>
      </button>
      <section class="gais-orb-panel" aria-label="Email Otter 待办">
        <header><strong>全部待办</strong><span class="gais-orb-total">0 项待办</span></header>
        <div class="gais-orb-list"><p class="gais-orb-empty">还没有待办</p></div>
      </section>
    `;
    const otterImage = orb.querySelector(".gais-orb-logo img");
    if (otterImage) otterImage.src = chrome.runtime.getURL("assets/icon-128.png");
    const setOpen = (open) => {
      orb.classList.toggle("gais-orb-open", open);
      orb.querySelector(".gais-orb-trigger")?.setAttribute("aria-expanded", String(open));
    };
    orb.querySelector(".gais-orb-trigger")?.addEventListener("click", () => {
      setOpen(!orb.classList.contains("gais-orb-open"));
    });
    document.addEventListener("pointerdown", (event) => {
      if (orb.classList.contains("gais-orb-open") && !orb.contains(event.target)) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && orb.classList.contains("gais-orb-open")) setOpen(false);
    });
    document.documentElement.append(orb);
    return orb;
  }

  function renderTaskOrb(tasks, addedCount = 0) {
    const orb = ensureTaskOrb();
    const safeTasks = Array.isArray(tasks) ? tasks : [];
    const count = orb.querySelector(".gais-orb-count");
    const total = orb.querySelector(".gais-orb-total");
    const list = orb.querySelector(".gais-orb-list");
    if (!count || !total || !list) return;

    const isFlashingAddedCount = Date.now() < taskOrbCountFlashUntil;
    if (!isFlashingAddedCount || addedCount > 0) {
      count.textContent = safeTasks.length > 99 ? "99+" : String(safeTasks.length);
      count.hidden = safeTasks.length === 0;
      count.classList.remove("gais-orb-count-added");
    }
    total.textContent = `${safeTasks.length} 项待办`;
    if (addedCount > 0) {
      taskOrbCountFlashUntil = Date.now() + 1500;
      clearTimeout(taskOrbCountFlashTimer);
      count.textContent = `+${addedCount}`;
      count.hidden = false;
      count.classList.add("gais-orb-count-added");
      taskOrbCountFlashTimer = setTimeout(() => {
        taskOrbCountFlashUntil = 0;
        refreshTaskOrb();
      }, 1500);
    }
    if (!safeTasks.length) {
      list.innerHTML = '<p class="gais-orb-empty">打开邮件后，待办会自动汇总在这里。</p>';
      return;
    }
    list.innerHTML = safeTasks.map((task) => `
      <article class="gais-orb-task">
        <button type="button" class="gais-orb-task-main" data-task-id="${escapeHtml(task.id)}" title="打开对应邮件">
          <strong>${escapeHtml(task.text)}</strong>
          <small>${escapeHtml(task.providerLabel)} · ${escapeHtml(task.subject)}</small>
        </button>
        <div class="gais-orb-task-actions" aria-label="待办操作">
          <button type="button" class="gais-orb-task-complete" data-task-id="${escapeHtml(task.id)}" title="标记完成并移除" aria-label="标记完成并移除">✓</button>
          <button type="button" class="gais-orb-task-remove" data-task-id="${escapeHtml(task.id)}" title="移除此待办" aria-label="移除此待办">×</button>
        </div>
      </article>
    `).join("");
    list.querySelectorAll(".gais-orb-task-main").forEach((button) => {
      button.addEventListener("click", async () => {
        const response = await sendMessage({ type: "OPEN_TASK_EMAIL", taskId: button.dataset.taskId });
        if (!response?.ok) {
          button.closest(".gais-orb-task")?.classList.add("gais-orb-task-error");
          setTimeout(() => button.closest(".gais-orb-task")?.classList.remove("gais-orb-task-error"), 1300);
        }
      });
    });
    list.querySelectorAll(".gais-orb-task-complete, .gais-orb-task-remove").forEach((button) => {
      button.addEventListener("click", async () => {
        const complete = button.classList.contains("gais-orb-task-complete");
        const response = await sendMessage({
          type: complete ? "COMPLETE_TASK" : "REMOVE_TASK",
          taskId: button.dataset.taskId
        });
        if (response?.ok) renderTaskOrb(response.tasks || []);
      });
    });
  }

  async function pruneCache() {
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all)
      .filter(([key]) => key.startsWith("summaryCache:"))
      .sort((a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0));
    const stale = entries.slice(MAX_CACHE_ITEMS).map(([key]) => key);
    if (stale.length) await chrome.storage.local.remove(stale);
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      if (!extensionAvailable()) {
        resolve({ ok: false, error: "扩展上下文已失效，请刷新邮箱页面" });
        return;
      }
      const runtime = typeof chrome !== "undefined" ? chrome.runtime : null;
      if (!runtime || typeof runtime.sendMessage !== "function") {
        resolve({ ok: false, error: "扩展上下文已失效，请刷新邮箱页面" });
        return;
      }
      try {
        runtime.sendMessage(message, (response) => {
          const runtimeError = runtime.lastError;
          if (runtimeError) {
            resolve({ ok: false, error: runtimeError.message });
          } else {
            resolve(response);
          }
        });
      } catch (error) {
        resolve({ ok: false, error: error?.message || "扩展上下文已失效，请刷新邮箱页面" });
      }
    });
  }

  function extensionAvailable() {
    const runtime = typeof chrome !== "undefined" ? chrome.runtime : null;
    return Boolean(runtime) && typeof runtime.sendMessage === "function";
  }

  function isExtensionContextUnavailable(error) {
    if (!extensionAvailable()) return true;
    const message = error?.message || String(error || "");
    return /extension context invalidated|reading ['"]sendMessage['"]/i.test(message);
  }

  function visibleElements(nodeList) {
    return [...nodeList].filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.id === CARD_ID || element.closest(`#${CARD_ID}, #${LEGACY_CARD_ID}`)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function nearestQuery(element, selector) {
    let current = element.parentElement;
    for (let i = 0; i < 7 && current; i += 1, current = current.parentElement) {
      const match = current.querySelector(selector);
      if (match) return match;
    }
    return null;
  }

  function findCommonAncestor(a, b) {
    const ancestors = new Set();
    for (let current = a; current; current = current.parentElement) ancestors.add(current);
    for (let current = b; current; current = current.parentElement) {
      if (ancestors.has(current)) return current;
    }
    return null;
  }

  function directChild(ancestor, node) {
    let current = node;
    while (current?.parentElement && current.parentElement !== ancestor) current = current.parentElement;
    return current?.parentElement === ancestor ? current : null;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function assetUrl(asset) {
    try {
      return chrome.runtime?.getURL?.(asset) || "";
    } catch {
      return "";
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
