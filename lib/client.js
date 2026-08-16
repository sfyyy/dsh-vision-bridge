/**
 * @dsh-extension/dsh-vision-bridge browser client.
 *
  * Registers a "Vision Bridge" section in the DSH Settings page (the
  * `settings.section` slot) with a small form for baseUrl / apiKey / model.
 * The form reads and writes the plugin's config through the same-origin
 * backend route `/_dsh/vision-bridge/settings` (registered by the host half).
 *
 * Hand-written in the DSH client ModuleLoader format — no build step needed.
 */
window.__ModuleLoader__.load({ id: "@dsh-extension/dsh-vision-bridge", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  "use strict";
  Object.defineProperty(exports, "__esModule", { value: true });

  const React = require("react");
  const { useEffect, useState } = React;
  const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
  const { Button, Input } = primitives;

  const ROUTE = "/_dsh/vision-bridge/settings";

  function el(type, props, ...children) {
    return React.createElement(type, props, ...children);
  }

  const card = {
    display: "grid", gap: "12px", maxWidth: "680px", padding: "8px 2px 24px",
    color: "var(--dsw-alias-label-primary,currentColor)",
  };
  const row = { display: "flex", gap: "10px", alignItems: "center" };
  const field = { display: "grid", gap: "6px", alignContent: "start" };
  const label = { fontSize: "12px", fontWeight: 600 };
  const muted = { margin: "0 0 4px", fontSize: "12px", color: "var(--dsw-alias-label-secondary,currentColor)", lineHeight: 1.5 };
  const alert = { padding: "10px 12px", borderRadius: "10px", fontSize: "12px", lineHeight: 1.5, background: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)", color: "var(--dsw-alias-state-error-primary,currentColor)" };
  const ok = { padding: "10px 12px", borderRadius: "10px", fontSize: "12px", background: "color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)", color: "var(--dsw-alias-state-success-primary,currentColor)" };
  const hint = { fontSize: "11px", color: "var(--dsw-alias-label-secondary,currentColor)" };

  function VisionBridgeSettings() {
    const [status, setStatus] = useState("loading");
    const [draft, setDraft] = useState(null);
    const [message, setMessage] = useState(null);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    async function load() {
      setStatus("loading"); setError(null);
      try {
        const res = await fetch(ROUTE, { credentials: "same-origin" });
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error((body && body.error && body.error.message) || "加载设置失败");
        const eff = (body.value && body.value.effective) || {};
        setDraft({
          enabled: eff.enabled !== false,
          baseUrl: eff.baseUrl || "",
          apiKey: eff.apiKey || "",
          model: eff.model || "",
        });
        setStatus("ready");
      } catch (e) {
        setError(e && e.message ? e.message : String(e));
        setStatus("error");
      }
    }

    useEffect(() => { void load(); }, []);

    function update(key, value) {
      setDraft((d) => (d ? { ...d, [key]: value } : d));
    }

    async function save() {
      if (!draft) return;
      setSaving(true); setError(null); setMessage(null);
      try {
        const res = await fetch(ROUTE, {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: draft }),
        });
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error((body && body.error && body.error.message) || "保存失败");
        setMessage("已保存，实时生效。需要看图时将通过 vision_describe 按需调用视觉模型。");
      } catch (e) {
        setError(e && e.message ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    }

    if (status === "loading") {
      return el("div", { style: card }, el("div", { style: muted }, "加载中…"));
    }
    if (status === "error") {
      return el("div", { style: card },
        el("div", { style: alert }, error),
        el("div", { style: row }, el(Button, { variant: "outline", onClick: () => void load() }, "重试")),
      );
    }
    if (!draft) return null;

    return el("div", { style: card },
      el("h3", { style: { margin: "2px 0" } }, "Vision Bridge — 视觉桥接"),
      el("p", { style: muted },
        "图片会保留在会话中；当前文本模型需要看图时，通过 vision_describe 按需调用第三方视觉模型。"),

      el("label", { style: row },
        el("input", { type: "checkbox", checked: draft.enabled, onChange: (e) => update("enabled", e.target.checked) }),
        el("span", { style: label }, "启用")),

      el("label", { style: field },
        el("span", { style: label }, "Base URL"),
        el(Input, { value: draft.baseUrl, placeholder: "https://api.openai.com/v1", onChange: (e) => update("baseUrl", e.target.value) }),
        el("small", { style: hint }, "OpenAI 兼容端点基址（自动补 /chat/completions）")),

      el("label", { style: field },
        el("span", { style: label }, "API Key"),
        el(Input, { value: draft.apiKey, placeholder: "sk-…", onChange: (e) => update("apiKey", e.target.value) })),

      el("label", { style: field },
        el("span", { style: label }, "模型"),
        el(Input, { value: draft.model, placeholder: "gpt-5.6-terra", onChange: (e) => update("model", e.target.value) })),

      el("div", { style: row },
        el(Button, { variant: "primary", onClick: () => void save(), disabled: saving }, saving ? "保存中…" : "保存并应用"),
        el(Button, { variant: "outline", onClick: () => void load() }, "重新加载")),

      message ? el("div", { style: ok }, message) : null,
      error ? el("div", { style: alert }, error) : null,
    );
  }

  exports.inject = ["slots"];

  exports.apply = function apply(ctx) {
    ctx.slots.inject("settings.section", function* () {
      yield ctx.slots.register({
        name: "settings.section",
        id: "vision-bridge",
        order: 35,
        label: () => "Vision Bridge",
        inject: () => ({}),
      }, VisionBridgeSettings);
    });
  };
  return module.exports;
}});
