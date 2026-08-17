(() => {
  const COMMON_CLEANUP = [
    "script",
    "style",
    "noscript",
    "svg",
    "button",
    "[aria-hidden=\"true\"]"
  ].join(",");

  const sites = {
    gmail: {
      label: "Gmail",
      hostnames: ["mail.google.com"],
      selectors: {
        subject: "h2.hP",
        bodies: ".a3s.aiL, .a3s",
        sender: ".gD[email], .gD",
        date: ".g3[title], .g3",
        attachments: ".aV3, [download_url] .aV3",
        messageRoot: "[data-message-id], .adn",
        cleanup: [
          COMMON_CLEANUP,
          ".gmail_signature",
          ".gmail_extra",
          "blockquote.gmail_quote",
          ".gmail_quote",
          "[data-smartmail=\"gmail_signature\"]"
        ].join(",")
      }
    },
    yahoo: {
      label: "Yahoo Mail",
      hostnames: ["mail.yahoo.com"],
      selectors: {
        subject: [
          "[data-test-id=\"message-subject\"]",
          "[data-test-id=\"message-view-subject\"]",
          "[data-test-id=\"message-view-header\"] h1",
          "[data-test-id=\"message-view-header\"] h2",
          "[class*='subject' i]",
          "[class*='message-title' i]",
          "h1",
          "h2"
        ].join(","),
        bodies: [
          "[data-test-id=\"message-view-body\"]",
          "[data-test-id=\"message-body\"]",
          "[data-test-id=\"message-view-body\"] [dir=\"ltr\"]",
          "[class*='message-body' i]",
          "[class*='message-content' i]",
          "[role=\"document\"]",
          "iframe"
        ].join(","),
        sender: [
          "[data-test-id=\"message-view-from\"]",
          "[data-test-id=\"message-view-header\"] [data-test-id*='sender' i]",
          "a[href^=\"mailto:\"]",
          "[title*='@']",
          "[aria-label*='@']"
        ].join(","),
        date: [
          "[data-test-id=\"message-view-date\"]",
          "[data-test-id=\"message-date\"]",
          "time",
          "[title*='202']",
          "[aria-label*='202']"
        ].join(","),
        attachments: [
          "[data-test-id*='attachment' i]",
          "[class*='attachment' i]",
          "a[href*='attachment' i]"
        ].join(","),
        messageRoot: [
          "[data-test-id=\"message-view\"]",
          "[data-test-id=\"message\"]",
          "[role=\"article\"]",
          "[class*='message-view' i]",
          "[class*='message' i]",
          "main"
        ].join(","),
        cleanup: [COMMON_CLEANUP, "[class*='signature' i]", "[class*='quoted' i]", "blockquote"].join(",")
      }
    },
    icloud: {
      label: "iCloud Mail",
      hostnames: ["www.icloud.com", "icloud.com"],
      selectors: {
        subject: [
          "[data-testid*='subject' i]",
          "[data-test-id*='subject' i]",
          "[aria-label*='subject' i]",
          "[class*='subject' i]",
          "h1",
          "h2"
        ].join(","),
        bodies: [
          "[data-testid*='message-body' i]",
          "[data-test-id*='message-body' i]",
          "[aria-label*='message body' i]",
          "[class*='message-body' i]",
          "[class*='message-content' i]",
          "[role=\"document\"]",
          "iframe"
        ].join(","),
        sender: [
          "[data-testid*='sender' i]",
          "[data-test-id*='sender' i]",
          "[aria-label*='from' i]",
          "a[href^=\"mailto:\"]",
          "[title*='@']",
          "[aria-label*='@']"
        ].join(","),
        date: [
          "[data-testid*='date' i]",
          "[data-test-id*='date' i]",
          "time",
          "[title*='202']",
          "[aria-label*='202']"
        ].join(","),
        attachments: [
          "[data-testid*='attachment' i]",
          "[data-test-id*='attachment' i]",
          "[class*='attachment' i]"
        ].join(","),
        messageRoot: [
          "[data-testid*='message' i]",
          "[data-test-id*='message' i]",
          "[role=\"article\"]",
          "[class*='message' i]",
          "main"
        ].join(","),
        cleanup: [COMMON_CLEANUP, "[class*='signature' i]", "[class*='quote' i]", "blockquote"].join(",")
      }
    },
    qq: {
      label: "QQ邮箱",
      hostnames: ["mail.qq.com", "wx.mail.qq.com"],
      selectors: {
        subject: [
          "[data-testid=\"mail-subject\"]",
          ".mail-subject",
          ".mail_subject",
          ".sub_title",
          ".subject",
          "h1[title]",
          "h2[title]",
          "h1",
          "h2",
          "[role=\"heading\"]",
          "[class*=\"subject\"]",
          "[class*=\"title\"]"
        ].join(","),
        bodies: [
          "[data-testid=\"mail-body\"]",
          ".mail-content",
          ".mail_content",
          ".mail-body",
          ".content-body",
          ".qm_editor",
          ".editor_content",
          "[class*=\"mail\"][class*=\"content\"]",
          "[class*=\"mail\"][class*=\"body\"]",
          "[class*=\"letter\"]",
          "iframe"
        ].join(","),
        sender: [
          "[data-testid=\"sender\"]",
          ".mail-sender",
          ".sender",
          ".from",
          "[class*='sender' i]",
          "[class*='from' i]",
          "[class*='address' i]",
          "a[href^=\"mailto:\"]",
          "[title*=\"@\"]"
        ].join(","),
        date: [
          "[data-testid=\"date\"]",
          ".mail-time",
          ".date",
          ".time",
          "[title*=\"202\"]"
        ].join(","),
        attachments: [
          "[data-testid*=\"attachment\"]",
          ".attachment",
          ".attach",
          "a[href*=\"attachment\"]"
        ].join(","),
        messageRoot: [
          "[data-testid=\"message\"]",
          ".mail-detail",
          ".mail-detail-container",
          ".message",
          ".mail",
          "main"
        ].join(","),
        cleanup: [COMMON_CLEANUP, ".signature", ".mail-signature", ".quote"].join(",")
      }
    },
    mail126: {
      label: "126邮箱",
      hostnames: ["mail.126.com"],
      selectors: {
        subject: [
          "[data-testid=\"mail-subject\"]",
          ".mail-subject",
          ".mail_subject",
          ".mailTitle",
          ".subject",
          "h1[title]",
          "h2[title]"
        ].join(","),
        bodies: [
          "[data-testid=\"mail-body\"]",
          ".mail-content",
          ".mail_content",
          ".mail-body",
          ".content-body",
          ".mailContent",
          ".netease_mail_content",
          "iframe"
        ].join(","),
        sender: [
          "[data-testid=\"sender\"]",
          ".mail-sender",
          ".sender",
          ".from",
          "a[href^=\"mailto:\"]",
          "[title*=\"@\"]"
        ].join(","),
        date: [
          "[data-testid=\"date\"]",
          ".mail-time",
          ".date",
          ".time",
          "[title*=\"202\"]"
        ].join(","),
        attachments: [
          "[data-testid*=\"attachment\"]",
          ".attachment",
          ".attach",
          "a[href*=\"attachment\"]"
        ].join(","),
        messageRoot: [
          "[data-testid=\"message\"]",
          ".mail-detail",
          ".mail-detail-container",
          ".message",
          ".mail",
          "main"
        ].join(","),
        cleanup: [COMMON_CLEANUP, ".signature", ".mail-signature", ".quote"].join(",")
      }
    },
    mail163: {
      label: "163邮箱",
      hostnames: ["mail.163.com"],
      selectors: {
        subject: [
          "[data-testid=\"mail-subject\"]",
          ".mail-subject",
          ".mail_subject",
          ".mailTitle",
          ".subject",
          "h1[title]",
          "h2[title]",
          "[class*='subject' i]",
          "[class*='title' i]"
        ].join(","),
        bodies: [
          "[data-testid=\"mail-body\"]",
          ".mail-content",
          ".mail_content",
          ".mail-body",
          ".content-body",
          ".mailContent",
          ".netease_mail_content",
          "[class*='message-body' i]",
          "iframe"
        ].join(","),
        sender: [
          "[data-testid=\"sender\"]",
          ".mail-sender",
          ".sender",
          ".from",
          "a[href^=\"mailto:\"]",
          "[title*='@']",
          "[aria-label*='@']"
        ].join(","),
        date: [
          "[data-testid=\"date\"]",
          ".mail-time",
          ".date",
          ".time",
          "time",
          "[title*='202']"
        ].join(","),
        attachments: [
          "[data-testid*='attachment' i]",
          ".attachment",
          ".attach",
          "a[href*='attachment' i]"
        ].join(","),
        messageRoot: [
          "[data-testid=\"message\"]",
          ".mail-detail",
          ".mail-detail-container",
          ".message",
          ".mail",
          "main"
        ].join(","),
        cleanup: [COMMON_CLEANUP, ".signature", ".mail-signature", ".quote", "blockquote"].join(",")
      }
    },
    outlook: {
      label: "Outlook",
      hostnames: ["outlook.live.com", "outlook.office.com", "outlook.office365.com"],
      selectors: {
        subject: [
          "[data-automation-id=\"messageSubject\"]",
          "[data-automation-id*=\"subject\" i]",
          "[aria-label=\"Subject\"]",
          "[aria-label*=\"邮件主题\"]",
          "[aria-label*=\"主题\"]",
          "[id*=\"subject\" i]",
          "[class*=\"subject\" i]",
          "h1[role=\"heading\"]",
          "h2[role=\"heading\"]",
          "h1",
          "h2"
        ].join(","),
        bodies: [
          "[data-automation-id=\"messageBody\"]",
          "[data-automation-id*=\"messagebody\" i]",
          "[data-automationid*=\"messagebody\" i]",
          "[aria-label=\"Message body\"]",
          "[aria-label*=\"message body\" i]",
          "[aria-label*=\"邮件正文\"]",
          "[aria-label*=\"正文\"]",
          "[id*=\"messagebody\" i]",
          "[class*=\"messagebody\" i]",
          "[class*=\"message-body\" i]",
          "[role=\"document\"]",
          ".x_body",
          ".ReadMsgBody",
          ".ExternalClass",
          "div[contenteditable=\"false\"]",
          "div[dir=\"ltr\"]",
          "iframe"
        ].join(","),
        sender: [
          "[data-automation-id=\"sender\"]",
          "[data-automation-id=\"from\"]",
          "[aria-label*=\"From\"]",
          ".x_sender",
          "a[href^=\"mailto:\"]",
          "[title*=\"@\"]"
        ].join(","),
        date: [
          "[data-automation-id=\"messageDate\"]",
          "[data-automation-id=\"date\"]",
          "[aria-label*=\"Received\"]",
          "[aria-label*=\"Date\"]",
          ".x_date"
        ].join(","),
        attachments: [
          "[data-automation-id*=\"attachment\"]",
          "[aria-label*=\"attachment\" i]",
          ".x_attachment",
          "a[href*=\"attachment\"]"
        ].join(","),
        messageRoot: [
          "[data-automation-id=\"message\"]",
          "[role=\"article\"]",
          ".x_message",
          "div[role=\"main\"]",
          "main"
        ].join(","),
        cleanup: [COMMON_CLEANUP, ".x_signature", ".x_gmail_quote", ".x_quote"].join(",")
      }
    }
  };

  const hostname = location.hostname.toLowerCase();
  const entry = Object.entries(sites).find(([, site]) => site.hostnames.includes(hostname));
  if (!entry) return;

  const [key, site] = entry;
  window.EmailOtterSite = {
    key,
    label: site.label,
    selectors: site.selectors,
    route: `${location.pathname}${location.hash}`
  };
})();
