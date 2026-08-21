/**
 * dsh-input-tools — 输入框工具条插件 v4.1（2026-08-20 改名自 dsh-client-composer）
 *
 * 功能三合一：图片（官方 draft 链路随文本发）+ 语音（录音/取消）+ 余额。
 *
 * v4 核心设计（对照用户要求逐条）：
 * 1) 图片"必须配文本发送"：走官方 draft 链路——插件注册 conversation.input.attachments 槽
 *    （priority:-1 覆盖官方附件条渲染），该槽 props 自带 onAddImages（=官方 intakeImages）：
 *    图片按钮选文件 → onAddImages → 图片进官方 draft → 官方发送按钮发送时自动带图 ✓
 * 2) 预览 = 插件自己的悬浮缩略图墙（absolute 定位在输入框上方，无背景、无边框），
 *    点击缩略图放大 modal，右上角 × 移除（调 onRemoveImage）——不是官方附件条样式；
 * 3) 没有"发送图片"按钮：发送动作完全由官方发送按钮承担，图片必然配文本发送；
 * 4) 语音：插件自实现（点击录音/秒数/×取消/取消不留垃圾）；
 * 5) 余额：conversation.input.right（独立 balance 插件已停用并删除）；
 * 6) 按钮位置：left 槽（源码 .tools 区，命令按钮之前：[🖼][🎙][+]）；
 * 7) 按钮间距：16px（与源码 .tools gap 一致）。
 *
 * 源码零改动：附件槽 props 由官方 ConversationRoot/InputBar 自动传入，无需桥接代码。
 */

window.__ModuleLoader__.load({
  id: "@oadank/dsh-input-tools",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    const { useState, useEffect, useRef, useCallback } = react;
    const h = react.createElement;

    const POLL_MS = 30_000;

    // ── 附件槽桥：官方 onAddImages 由 attachments 槽组件挂载时存入，left 按钮调用 ──
    let sharedOnAddImages = null;
    // [2026-08-21] draft 图片共享：attachments 槽挂载时把当前 draft 图（ComposerAttachment[]）
    // 与移除回调存入模块级，语音发送时可一起带上、发完清掉（解决"选了图发语音图被留下"）。
    let sharedDraftImages = [];
    let sharedRemoveImage = null;

    // ── [2026-08-21] 语音气泡（聊天界面 DOM 注入，安装即用，不依赖 dsh 源码支持）────
    // 录音 → 存服务器（/voice/outbox/save）→ ASR 转文本 → 发【用户语音】标记文本；
    // observer 发现带标记的消息 → 注入语音条（可播放）。dsh 原生支持 voice 的版本
    // （rc.8 本地改造）走多模态直发，消息本身没有该标记，不会触发注入（官方渲染语音条）。
    let voiceBubbleStarted = false;
    const pendingVoiceQueue = []; // [{ voiceId, ext }] 待消费的录音（FIFO）
    const injectedVoiceEls = new WeakSet(); // 已注入的元素
    const VOICE_MSG_MARK = "【用户语音】";

    function startVoiceBubbleObserver() {
      if (voiceBubbleStarted || typeof MutationObserver === "undefined") return;
      voiceBubbleStarted = true;
      const tryInject = () => {
        const els = Array.from(document.querySelectorAll("div,span,p,li"));
        for (const el of els) {
          if (injectedVoiceEls.has(el)) continue;
          if (el.querySelector("audio[data-voice-bubble]")) { injectedVoiceEls.add(el); continue; }
          const text = el.textContent ?? "";
          // [2026-08-21] AI 语音回复：**已禁用**。DOM 注入在 React 重渲染下会随 Tool call 展开/折叠
// 重复注入、位置漂移、无限累积（用户实测图1-4），修不干净。AI 语音条走源码版（voice/reply
// 事件原生渲染）；rc.7 上 AI 语音音频已生成但界面不显示，属 rc.7 硬伤，引导用户使用源码版。
          // if (text.includes("语音已发送") && text.includes("voiceId") && text.includes("sha256:")) { ... 注入 ... }
          if (!text.includes(VOICE_MSG_MARK)) continue;
          // 只处理"叶子级"文本块：若子元素已含标记（父容器），跳过避免重复注入
          let childHasMark = false;
          for (const c of el.children) {
            if ((c.textContent ?? "").includes(VOICE_MSG_MARK)) { childHasMark = true; break; }
          }
          if (childHasMark) continue;
          const meta = pendingVoiceQueue.shift();
          if (meta) injectVoiceCard(el, `/voice/outbox/${meta.voiceId}.${meta.ext || "webm"}`, 1); /* 用户消息气泡内 */
          injectedVoiceEls.add(el);
        }
      };
      const obs = new MutationObserver(() => tryInject());
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      tryInject();
    }

    function injectVoiceCard(anchorEl, audioSrc, hop = 1) {
      try {
        // [2026-08-21 修] 不再硬编码爬 7 层（之前导致 AI 语音条藏到 Tool call 折叠块里）——
        // 改为可指定爬层数：
        //   1 = 用户消息：爬 1 层到消息气泡内（气泡可能就在文本的父级）
        //   6 = AI 语音回复：爬 6 层穿透 Tool call 折叠卡到主 assistant message 行
        let host = anchorEl;
        for (let i = 0; i < hop && host.parentElement; i++) host = host.parentElement;
        if (!host || host.querySelector("audio[data-voice-bubble]")) return;
        const audio = document.createElement("audio");
        audio.src = audioSrc;
        audio.preload = "metadata";
        audio.dataset.voiceBubble = "1";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:none;border-radius:50%;background:rgba(229,72,77,.18);color:#e5484d;cursor:pointer;font-size:14px;flex:none;line-height:1;";
        btn.textContent = "▶";
        btn.onclick = () => { if (audio.paused) { void audio.play(); btn.textContent = "⏸"; } else { audio.pause(); btn.textContent = "▶"; } };
        audio.onended = () => { btn.textContent = "▶"; };
        audio.onerror = () => { btn.textContent = "⚠"; btn.title = "音频加载失败"; };
        const dur = document.createElement("span");
        dur.style.cssText = "font-size:11px;opacity:.75;min-width:26px;";
        audio.onloadedmetadata = () => {
          const s = Math.round(audio.duration || 0);
          dur.textContent = s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "";
        };
        const card = document.createElement("div");
        card.style.cssText = "display:inline-flex;align-items:center;gap:8px;background:rgba(229,72,77,.1);border:1px solid rgba(229,72,77,.28);border-radius:999px;padding:4px 12px;margin-top:6px;width:fit-content;max-width:260px;align-self:flex-start;";
        card.append(btn, dur);
        host.appendChild(card);
      } catch { /* 注入失败不影响消息 */ }
    }

    // ── 源码 SVG 图标 ────────────────────────────────────────────
    const svgProps = { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true };
    const imageIcon = h("svg", svgProps,
      h("rect", { x: "2.5", y: "3.5", width: "11", height: "9", rx: "2", fill: "none", stroke: "currentColor", strokeWidth: "1.4" }),
      h("circle", { cx: "6", cy: "7.5", r: "1.5", fill: "currentColor" }),
      h("path", { d: "M3.5 11.5 L6.5 8.5 L9 10.5 L11.5 8 L13.5 10.5", stroke: "currentColor", strokeWidth: "1.2", fill: "none" }),
    );
    const micIcon = h("svg", svgProps,
      h("path", { d: "M8 1.5C6.895 1.5 6 2.395 6 3.5V8C6 9.105 6.895 10 8 10C9.105 10 10 9.105 10 8V3.5C10 2.395 9.105 1.5 8 1.5Z", fill: "currentColor" }),
      h("path", { d: "M3.5 7.5V8C3.5 10.485 5.515 12.5 8 12.5C10.485 12.5 12.5 10.485 12.5 8V7.5H14V8C14 11.087 11.683 13.615 8.75 13.936V15.5H7.25V13.936C4.317 13.615 2 11.087 2 8V7.5H3.5Z", fill: "currentColor" }),
    );
    const cancelIcon = h("svg", svgProps,
      h("path", { d: "M4 4L12 12M12 4L4 12", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }),
    );

    // ── 工具行按钮样式：圆形底，间距 16px（与源码 .tools gap 一致） ─────
    const circleBtn = {
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: "32px", height: "32px", padding: "0", border: "none",
      borderRadius: "999px",
      background: "rgba(128,128,128,.16)",
      color: "inherit", cursor: "pointer",
      transition: "background-color .15s",
    };

    // ── 左工具行：图片（官方 draft 链路）+ 语音 ─────────────────────
    function ToolbarLeft({ connection, sessionId }) {
      const [recording, setRecording] = useState(false);
      const [seconds, setSeconds] = useState(0);
      const [voiceError, setVoiceError] = useState(null); // 语音发送失败提示
      const voiceErrorTimerRef = useRef(null);
      const recorderRef = useRef(null);
      const chunksRef = useRef([]);
      const timerRef = useRef(null);
      const fileRef = useRef(null);
      const voiceSupported = typeof navigator !== "undefined" && typeof MediaRecorder !== "undefined";
      // [2026-08-21] 语音气泡注入：页面一挂载就监听消息流，给【用户语音】消息贴语音条
      useEffect(() => { startVoiceBubbleObserver(); }, []);

      const sendVoiceBlob = useCallback(async (blob) => {
        if (connection === undefined) return;
        const mediaType = blob.type.split(";")[0] || "audio/webm";
        const reader = new FileReader();
        const data = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        const fail = (msg) => {
          setVoiceError(msg);
          if (voiceErrorTimerRef.current !== null) window.clearTimeout(voiceErrorTimerRef.current);
          voiceErrorTimerRef.current = window.setTimeout(() => setVoiceError(null), 6000);
        };
        // [2026-08-21] draft 图片转 image content（File→base64），语音可与图片一起发送
        const draftImageContents = async () => {
          const imgs = Array.isArray(sharedDraftImages) ? sharedDraftImages : [];
          const out = [];
          for (const a of imgs) {
            const file = a?.file;
            if (!file) continue;
            const b64 = await new Promise((resolve) => {
              const r = new FileReader();
              r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
              r.onerror = () => resolve("");
              r.readAsDataURL(file);
            });
            if (b64 !== "") out.push({ type: "image", mediaType: file.type || "image/jpeg", data: b64, name: file.name });
          }
          return out;
        };
        // [2026-08-21] 语音发送成功后清掉 draft 图片（否则图还留在输入框上）
        const clearDraftImages = () => {
          const imgs = Array.isArray(sharedDraftImages) ? sharedDraftImages : [];
          if (typeof sharedRemoveImage === "function") {
            for (const a of imgs) { try { sharedRemoveImage(a.id); } catch { /* ignore */ } }
          }
          sharedDraftImages = [];
        };
        const sendAsText = async (text, images) => {
          // [2026-08-21] 降级路径：XDN(npm rc.7) 不支持 voice content。带【用户语音】标记让 AI
          // 知道这是语音转的文本，可以按规则(自动 TTS)回复。
          const marked = "【用户语音】" + text;
          const response = await connection.api.sessions.prompt({
            sessionId, mode: "queue",
            content: [{ type: "text", text: marked }, ...images],
          });
          const result = response?.result;
          if (!result || !result.ok) {
            fail((result?.error && typeof result.error.message === "string" && result.error.message !== "")
              ? result.error.message : "语音发送失败，请重试");
          }
        };
        const sendAsVoice = async (images) => {
          // 首选：多模态直发（AI 能听原音，消息渲染为语音气泡）——本机 lecoo / dev rc.8 支持
          const response = await connection.api.sessions.prompt({
            sessionId, mode: "queue",
            content: [{ type: "voice", mediaType, data }, ...images],
          });
          return response?.result;
        };
        try {
          const images = await draftImageContents();
          // [2026-08-21 修] 先直发 voice，失败时降级 ASR 转文本（rc.7 兼容）。
          // 这样本机/rc.8 享受多模态（AI 听到原音 + 语音消息气泡），XDN/rc.7 自动降级不报错。
          let result;
          try {
            result = await sendAsVoice(images);
          } catch (voiceErr) {
            result = null;
          }
          // 直发成功（rc.8/dev）：result.ok true
          if (result && result.ok) { clearDraftImages(); return; }
          // 失败或不支持：尝试降级
          const errMsg = result?.error?.message ?? "";
          // 只有"contract/payload"类错误才降级；其他业务错误直接提示
          const isContractError = /invalid payload|schema|contract|not supported|unsupported/i.test(errMsg);
          if (!isContractError && result && !result.ok) {
            fail(errMsg || "语音发送失败，请重试");
            return;
          }
          // 走 ASR 转文本（降级路径：dsh 契约不支持 voice content）
          // 先把录音存到服务器（语音气泡数据源），再识别再发【用户语音】标记文本
          try {
            const sv = await (await fetch("/voice/outbox/save", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ audioBase64: data, mediaType }),
            })).json().catch(() => ({}));
            if (sv?.ok) pendingVoiceQueue.push({ voiceId: sv.voiceId, ext: sv.ext ?? "webm" });
          } catch { /* 存档失败不阻塞发送 */ }
          const tr = await fetch("/asr/transcribe", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ audioBase64: data, mediaType }),
          });
          const td = await tr.json().catch(() => ({}));
          if (!td?.ok) { fail(td?.error ?? "语音识别失败，请检查 ASR 配置"); return; }
          const text = typeof td?.text === "string" ? td.text.trim() : "";
          if (text === "") { fail("没听清，请再说一次"); return; }
          await sendAsText(text, images);
          clearDraftImages();
        } catch (e) {
          fail(String(e && typeof e.message === "string" && e.message !== "" ? e.message : e));
        }
      }, [connection, sessionId]);

      const stopRecording = useCallback((send) => {
        clearInterval(timerRef.current);
        timerRef.current = null;
        const recorder = recorderRef.current;
        recorderRef.current = null;
        if (recorder !== null && recorder.state !== "inactive") {
          if (send) recorder.stop();
          else { recorder.onstop = null; try { recorder.stop(); } catch { /* ignore */ } }
        }
        setRecording(false);
        setSeconds(0);
      }, []);

      const startRecording = useCallback(async () => {
        if (connection === undefined || sessionId === undefined) return;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const recorder = new MediaRecorder(stream);
          chunksRef.current = [];
          recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
          recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
            chunksRef.current = [];
            if (blob.size > 0) void sendVoiceBlob(blob);
            stream.getTracks().forEach((t) => t.stop());
          };
          recorder.start();
          recorderRef.current = recorder;
          setRecording(true);
          setSeconds(0);
          timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
        } catch { /* 权限拒绝 */ }
      }, [connection, sessionId, sendVoiceBlob]);

      // 图片选中 → 官方 onAddImages（intakeImages）→ 官方 draft → 随文本发送
      const onPickImage = useCallback((event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length === 0 || typeof sharedOnAddImages !== "function") return;
        sharedOnAddImages(files);
      }, []);

      return h("div", { style: { position: "relative", display: "inline-flex", alignItems: "center", gap: "16px" } },
        h("button", {
          type: "button", "aria-label": "添加图片", title: "添加图片",
          style: circleBtn, onMouseDown: (e) => e.preventDefault(),
          onClick: () => fileRef.current?.click(),
        }, imageIcon),
        h("input", {
          ref: fileRef, type: "file",
          accept: "image/png,image/jpeg,image/webp,image/gif",
          multiple: false, hidden: true, onChange: onPickImage,
        }),
        voiceSupported && h("button", {
          type: "button",
          "aria-label": recording ? "停止并发送" : "录音",
          title: recording ? "停止并发送" : "录音",
          style: { ...circleBtn, ...(recording ? { background: "#e5484d", color: "#fff" } : {}) },
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => { if (recording) stopRecording(true); else void startRecording(); },
        }, recording
          ? h("span", {
              style: { display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "11px", fontWeight: 600 },
            }, h("span", {
              style: { width: "6px", height: "6px", borderRadius: "50%", background: "#fff", display: "inline-block" },
            }), `${seconds}s`)
          : micIcon),
        recording && h("button", {
          type: "button", "aria-label": "取消录音", title: "取消",
          style: circleBtn, onMouseDown: (e) => e.preventDefault(),
          onClick: () => stopRecording(false),
        }, cancelIcon),
        // [本地改造 2026-08-21] 语音发送失败提示（ASR 未配置/识别失败）：按钮上方气泡
        voiceError !== null && h("div", {
          style: {
            position: "absolute", bottom: "calc(100% + 8px)", left: "0", zIndex: 30,
            maxWidth: "380px", background: "rgba(229,72,77,.12)", color: "#e5484d",
            border: "1px solid rgba(229,72,77,.35)", borderRadius: "8px",
            padding: "6px 10px", fontSize: "12px", lineHeight: 1.45, whiteSpace: "normal",
            pointerEvents: "none", boxShadow: "0 4px 14px rgba(0,0,0,.25)",
          },
        }, voiceError),
      );
    }

    // ── 附件槽（覆盖官方）：悬浮缩略图墙 + 放大 modal，无背景无边框 ─────
    function ComposerAttachmentsOverlay({ attachments, onAddImages, onRemoveImage }) {
      const [zoom, setZoom] = useState(null); // { id, url, name } | null
      const items = Array.isArray(attachments) ? attachments : [];
      const hasItems = items.length > 0;

      // 官方 onAddImages 存入模块级，供 left 按钮使用
      useEffect(() => {
        if (typeof onAddImages === "function") sharedOnAddImages = onAddImages;
      }, [onAddImages]);

      // [2026-08-21] draft 图同步到模块级（语音发送一起带 + 发完清掉）
      useEffect(() => {
        sharedDraftImages = Array.isArray(attachments) ? attachments : [];
        if (typeof onRemoveImage === "function") sharedRemoveImage = onRemoveImage;
      }, [attachments, onRemoveImage]);

      useEffect(() => {
        if (zoom !== null && !items.some((a) => a.id === zoom.id)) setZoom(null);
      }, [items, zoom]);

      if (!hasItems) return null;
      return h("div", {
        style: {
          position: "absolute", bottom: "calc(100% + 8px)", left: "10px", zIndex: 20,
          display: "flex", flexWrap: "wrap", gap: "6px",
          padding: "0", margin: "0", background: "transparent", border: "none",
          pointerEvents: "none",
        },
      }, items.map((a) => h("div", {
        key: a.id,
        style: {
          position: "relative", width: "60px", height: "60px", borderRadius: "6px",
          overflow: "hidden", cursor: "zoom-in", background: "rgba(128,128,128,.1)",
          pointerEvents: "auto",
        },
        onClick: () => setZoom({ id: a.id, url: a.previewUrl, name: a.file?.name ?? "image" }),
      },
        h("img", {
          src: a.previewUrl, alt: a.file?.name ?? "image",
          style: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
        }),
        h("button", {
          type: "button", "aria-label": "移除", title: "移除",
          style: {
            position: "absolute", top: "2px", right: "2px",
            width: "18px", height: "18px", padding: "0", border: "none", borderRadius: "50%",
            background: "rgba(0,0,0,.6)", color: "#fff", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", lineHeight: "1",
          },
          onClick: (e) => { e.stopPropagation(); if (typeof onRemoveImage === "function") onRemoveImage(a.id); },
        }, "×"),
      )),
        // 放大 modal
        zoom !== null ? h("div", {
          role: "dialog", "aria-label": "图片预览",
          style: {
            position: "fixed", inset: "0", zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,.78)", cursor: "zoom-out",
            // modal 是缩略图墙 div 的子节点，外层 pointerEvents:none 会继承；显式 auto 让按钮能点
            pointerEvents: "auto",
          },
          onClick: () => setZoom(null),
        },
          h("img", {
            src: zoom.url, alt: zoom.name,
            style: { maxWidth: "92vw", maxHeight: "92vh", objectFit: "contain", borderRadius: "8px", boxShadow: "0 12px 48px rgba(0,0,0,.5)" },
          }),
          h("button", {
            type: "button", "aria-label": "关闭",
            style: {
              position: "absolute", top: "12px", right: "16px",
              width: "36px", height: "36px", padding: "0", border: "none", borderRadius: "50%",
              background: "rgba(0,0,0,.5)", color: "#fff", cursor: "pointer",
              fontSize: "18px", lineHeight: "1",
            },
            onClick: () => setZoom(null),
          }, "×"),
        ) : null,
      );
    }

    // ── 右工具行：余额 ─────────────────────────────────────────────
    function BalanceMeter({ connection, sessionId }) {
      const [balance, setBalance] = useState(null);
      const [visible, setVisible] = useState(false);
      const refresh = useCallback(async () => {
        if (connection === undefined) return;
        try {
          const response = await connection.api.balance.get({ sessionId });
          if (!response.result.ok) return;
          const value = response.result.value.balance;
          setBalance(value);
          setVisible(value !== null);
        } catch { /* 静默 */ }
      }, [connection, sessionId]);
      useEffect(() => { void refresh(); }, [refresh]);
      useEffect(() => {
        const timer = setInterval(() => { void refresh(); }, POLL_MS);
        return () => clearInterval(timer);
      }, [refresh]);

      if (!visible || balance === null) return null;
      const label = `余额: ¥${balance.total}`;
      return h("span", {
        title: `总额 ¥${balance.total} · 赠送 ¥${balance.granted} · 充值 ¥${balance.toppedUp}`,
        style: { display: "inline-flex", alignItems: "center", fontSize: "12px", opacity: 0.85, whiteSpace: "nowrap", cursor: "default" },
      }, h("button", {
        type: "button", "aria-label": label, title: label,
        style: { border: "none", background: "transparent", color: "inherit", cursor: "default", fontSize: "inherit", padding: "0 4px" },
      }, label));
    }

    // ── 设置页：语音服务分区（settings.section，读写 ~/.dsh/voice-config.json）──
    const VOICE_RULES = [
      "1) 用户本轮发过语音 → 必须语音回复（使用上方选择的默认引擎）",
      "2) 用户文本明确要求发语音 / 指定服务商（小米/微软）→ 自动合成（用指定 provider）",
      "3) 其他情况不自动合成——agent 自主决定，需要时调用 send_voice 工具主动发（仍按默认引擎）",
    ];
    // 自然语言风格预设（xiaomi context，强差异）
    const STYLE_PRESETS = [
      { key: "", label: "自然（默认）", ctx: "" },
      { key: "joyful", label: "欢快活泼", ctx: "用欢快、活泼的语气，语速轻快，带着笑意，声音明亮有活力" },
      { key: "gentle", label: "温柔亲切", ctx: "用温柔、亲切的语气，语速平缓，声音柔和，像在关怀对方" },
      { key: "calm", label: "沉稳严肃", ctx: "用沉稳、严肃的语气，语速适中偏慢，声音厚重，正式播报感" },
      { key: "broadcast", label: "播音腔", ctx: "用标准播音腔，吐字清晰，节奏分明，抑扬顿挫，专业新闻播报" },
      { key: "whisper", label: "低语私密", ctx: "用低沉、私密的低语语气，音量放轻，语速缓慢，像耳语般亲近" },
      { key: "excited", label: "兴奋激动", ctx: "用兴奋、激动的语气，语速快，音调上扬，情绪饱满有感染力" },
    ];
    // 常用情绪（voicedesign 试听：叠加在"音色描述"之上的表演指令，不写性别/年龄——那是音色描述的事）
    // 写法参照 MiMo 官方"自然语言控制"示例：语速、气息、停顿、音调、共鸣都要有可感细节
    const EMOTIONS = [
      { key: "happy", label: "开心", ctx: "用开心、欢快的语气，语速轻快，带着抑制不住的笑意，声音明亮上扬，尾音微微翘起" },
      { key: "sad", label: "难过", ctx: "用难过、低落的语气，语速缓慢，声音轻柔低沉，气息断断续续，带着淡淡的忧伤和哽咽感" },
      { key: "angry", label: "愤怒", ctx: "用愤怒、激动的语气，语速急促，声音强硬有力，气息加重，字字用力，带爆发感" },
      { key: "gentle", label: "温柔", ctx: "用温柔、关切的语气，语速平缓，气息绵软，声音柔和亲切，像在轻声安抚对方" },
      { key: "calm", label: "平静", ctx: "用平静、沉稳的语气，语速适中，气息平稳，声音波澜不惊，字正腔圆" },
      { key: "playful", label: "俏皮", ctx: "用俏皮、活泼的语气，语速轻快，声音带点机灵劲，尾音上扬，像在逗趣" },
      { key: "cold", label: "高冷", ctx: "用高冷、疏离的语气，语速偏慢，声音平淡克制，字字清晰，像隔着一层冰" },
      { key: "magnetic", label: "磁性", ctx: "用磁性、醇厚的语气，语速稍慢，气息低沉共鸣，声音富有魅力，尾音带拖腔" },
      { key: "excited", label: "兴奋", ctx: "用兴奋、高昂的语气，语速快，声音高亢明亮，情绪饱满，气息急促上扬" },
      { key: "grievance", label: "委屈", ctx: "用委屈、哽咽的语气，语速慢，声音发颤带鼻音，像忍着泪说话" },
      { key: "lazy", label: "慵懒", ctx: "用慵懒、松弛的语气，语速慢悠悠，声音松散，气息不紧不慢，漫不经心" },
      { key: "deep", label: "深沉", ctx: "用深沉、厚重的语气，若有所思，语速稳中有顿挫，声音偏低，字字有分量" },
    ];
    const ENGINES_ORDER = ["edge", "xiaomi", "voiceclone", "local", "ali"];
    const ENGINE_LABELS = {
      edge: "微软 edge（免费）", xiaomi: "小米 MiMo", voiceclone: "小米克隆（VoiceClone）", local: "本地 TTS", ali: "阿里 qwen3-tts",
    };
    const MIMO_DOC_URL = "https://mimo.mi.com/models/zh-CN/mimo-v2.5-tts";
    // VoiceDesign 官方示例（音色设计：Instruct=音色描述/导演指令，Text=要朗读的文本）
    const VOICE_DESIGN_EXAMPLES = [
      {
        title: "ASMR 双耳女声",
        instruct: "年轻的女性声音，近距离的聆听效果，带有双耳刺激的ASMR感。可以听到她的呼吸声、轻微的吞咽声，以及轻柔的自然唇音。她的说话速度非常慢，营造出一种极度放松且沉浸式的体验。",
        text: "[在你耳边低语] 嘘……放松点，再靠近一点吧。我现在就在你身边。慢慢、轻柔地呼吸，让思绪随着水流轻轻流淌，就像沉浸在温暖的水中一样。",
      },
      {
        title: "纪录片旁白",
        instruct: "一位中年男性，说标准普通话，嗓音低沉有磁性，带有轻微的沙哑质感，像纪录片旁白解说员，沉稳而有感染力。",
        text: "当最后一缕阳光消失在地平线之下，这片沉睡了亿万年的大地开始显露它真正的面貌。在这寂静的荒野中，每一块岩石都记录着时间的流逝，每一阵风都在诉说着古老的故事。",
      },
      {
        title: "年迈老先生旁白",
        instruct: "一位年迈的老先生，说带北方口音的普通话，语速缓慢而沉稳，嗓音略带沙哑和沧桑感，仿佛一位饱经风霜的老爷爷在讲故事，充满岁月的智慧。",
        text: "我这辈子啊，走南闯北六十多年。见过最热闹的集市，也见过最安静的戈壁。到头来才明白一个道理——这人哪，不在走了多远的路，在于记住了多少风景。年轻人，别光顾着赶路，偶尔也停下来看看天。",
      },
    ];
    // VoiceDesign 默认音色描述（用户未填时的兜底，含性别锚点）
    const DEFAULT_VOICE_DESC = "青年女性，声音甜美明亮，普通话标准，语速适中，活泼开朗";
    // [本地改造 2026-08-21] 所有克隆音色的统一试听文本（与每个样本自己的风格指令配合，
    // 试听时能同时听出"音色+个性"；如小团团样本的指令让它念这句时自然带沙雕可爱腔）
    const CLONE_PREVIEW_TEXT = "喂喂喂！你怎么才来呀？我都等你老半天啦！我跟你说啊——你今天可不能凶我哦，因为……因为你又不娶我，哼！不过嘛，看在你这么乖的份上，本小姐今天心情好，就大发慈悲原谅你啦！嘿嘿嘿～走吧走吧，出发喽！";

    const vInput = {
      background: "var(--dsw-specific-input-fill,#1e2128)", color: "var(--dsw-alias-label-primary,#e6e9ef)",
      border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "6px",
      padding: "6px 10px", fontSize: "12.5px", fontFamily: "inherit", width: "100%",
      boxSizing: "border-box",
    };
    const vField = (labelText, node) => h("label", {
      style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", flex: "1 1 45%", minWidth: "220px" },
    }, labelText, node);
    // 服务商卡片（[本地改造 2026-08-21] 去复选框改折叠）：标题栏点击展开/收起。
    // 配置填写与启用与否无关——只要填了 AI 就能调用，所以不再用 enabled 开关控制。
    const vCard = (title, open, onToggle, children) => h("div", {
      style: { border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px", background: "rgba(128,128,128,.05)" },
    },
      h("div", {
        style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" },
        onClick: onToggle,
      },
        h("span", { style: { display: "inline-flex", width: "22px", height: "22px", borderRadius: "6px", background: "rgba(128,128,128,.12)", alignItems: "center", justifyContent: "center", color: "var(--vk-accent,#4b6fff)", flex: "none" } }, micIcon),
        h("span", { style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, title),
        h("span", { style: { marginLeft: "auto", fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", flex: "none" } }, open ? "收起 ▴" : "展开 ▾"),
      ),
      open ? (typeof children === "function" ? children(true) : children) : null,
    );

    function VoiceSettingsSection() {
      const [config, setConfig] = useState(null);
      const [meta, setMeta] = useState(null);
      // [2026-08-21] 语音能力状态面板（安装即用能力 vs dsh 原生契约支持）
      const [caps, setCaps] = useState(null);
      useEffect(() => {
        fetch("/voice/capabilities").then((r) => r.json()).then((d) => {
          if (d?.ok) setCaps(d.capabilities);
        }).catch(() => { /* 检测失败不阻塞设置页 */ });
      }, []);
      // [本地改造 2026-08-21] 服务商卡片折叠状态（去复选框后由折叠控制显隐，默认展开）
      const [openCards, setOpenCards] = useState({ edge: true, xiaomi: true, local: true, ali: true });
      const toggleCard = (key) => setOpenCards((s) => ({ ...s, [key]: !s[key] }));
      const [previewing, setPreviewing] = useState(null); // 正在试听的标识：engine / emotion:key / style:key
      const [rulesPinned, setRulesPinned] = useState(false);
      const [rulesHover, setRulesHover] = useState(false);
      const [cloneListTipPinned, setCloneListTipPinned] = useState(false);
      const [cloneListTipHover, setCloneListTipHover] = useState(false);
      const [designTipPinned, setDesignTipPinned] = useState(false);
      const [designTipHover, setDesignTipHover] = useState(false);
      const [asrTipPinned, setAsrTipPinned] = useState(false);
      const [asrTipHover, setAsrTipHover] = useState(false);
      const [xmTipPinned, setXmTipPinned] = useState(false);
      const [xmTipHover, setXmTipHover] = useState(false);
      // 本地 TTS 卡片标题的 ? 提示 state
      const [localTipPinned, setLocalTipPinned] = useState(false);
      const [localTipHover, setLocalTipHover] = useState(false);
      // 3 个 VoiceDesign 官方示例的 Instruct/Text 悬浮提示 state
      const [vdExamplePins, setVdExamplePins] = useState([false, false, false]);
      const [vdExampleHovers, setVdExampleHovers] = useState([false, false, false]);
      const previewRef = useRef(null);
      const previewTagRef = useRef(null); // [本地改造 2026-08-21] 当前播放的试听 tag，用于「再点=停止」
      const newCloneNameRef = useRef(null);
      const newClonePathRef = useRef(null);
      // ASR 语音识别测试状态（示例音频 + 识别）
      const [asrResult, setAsrResult] = useState(null); // { ok, text, busy } | null
      // [本地改造 2026-08-21] 克隆样本添加（选择音频 → 上传 → 命名）
      const [cloneName, setCloneName] = useState("");
      const [addingClone, setAddingClone] = useState(false);
      const [cloneAddMsg, setCloneAddMsg] = useState(null); // { ok, text } | null
      const cloneFileRef = useRef(null);
      const asrAudioRef = useRef(null);
      const asrSampleBase64Ref = useRef(null);
      const [asrInstalling, setAsrInstalling] = useState(false); // 一键安装进行中
      const [asrCmd, setAsrCmd] = useState(null); // 待手动复制的安装命令
      const [vdSamples, setVdSamples] = useState([]); // VoiceDesign 官方示例音频（预生成）
      // [2026-08-21] 试听失败的错误提示（之前失败静默无反馈）
      const [previewErr, setPreviewErr] = useState(null);
      // [2026-08-22] 试听失败浮动 Toast（fixed 顶部居中，醒目弹窗式，6 秒自动消失）
      useEffect(() => {
        if (previewErr === null) return;
        const t = window.setTimeout(() => setPreviewErr(null), 6000);
        return () => window.clearTimeout(t);
      }, [previewErr]);
      // [2026-08-21] API Key 明文/密文切换（眼睛图标）
      const [showKeys, setShowKeys] = useState({});
      // [2026-08-21] 本地 TTS 一键安装命令
      const [ttsInstalling, setTtsInstalling] = useState(false);
      const [ttsCmd, setTtsCmd] = useState(null);
      // [2026-08-21] 密钥输入框 + 眼睛切换（明文/密文），keyName 作 state map 键
      const secretField = (labelText, keyName, value, onChange, placeholder) => h("label", {
        style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", flex: "1 1 45%", minWidth: "220px" },
      }, labelText,
        h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
          h("input", {
            type: showKeys[keyName] ? "text" : "password",
            value: value,
            onChange: onChange,
            placeholder: placeholder,
            style: { ...vInput, flex: 1 },
          }),
          h("button", {
            type: "button", "aria-label": showKeys[keyName] ? "隐藏密钥" : "显示密钥", title: showKeys[keyName] ? "隐藏密钥" : "显示密钥",
            style: {
              border: "none", borderRadius: "6px", width: "32px", height: "32px", flex: "none",
              background: "rgba(128,128,128,.12)", color: "inherit", cursor: "pointer", fontSize: "14px",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            },
            onMouseDown: (e) => e.preventDefault(),
            onClick: () => setShowKeys((s) => ({ ...s, [keyName]: !s[keyName] })),
          }, showKeys[keyName] ? "🙈" : "👁"),
        ),
      );

      useEffect(() => {
        let dead = false;
        fetch("/voice-config").then((r) => r.json()).then((d) => { if (!dead && d?.ok) setConfig(d.config); }).catch(() => {});
        fetch("/voice-config/engines").then((r) => r.json()).then((d) => { if (!dead && d?.ok) setMeta(d.engines); }).catch(() => {});
        // 自动加载 ASR 示例音频（无需手动点"加载"）
        fetch("/asr/sample").then((r) => r.json()).then((d) => {
          if (!dead && d?.ok) {
            asrSampleBase64Ref.current = d.data;
            if (asrAudioRef.current !== null) asrAudioRef.current.src = "data:" + d.mediaType + ";base64," + d.data;
          }
        }).catch(() => {});
        // 自动加载 VoiceDesign 官方示例音频（预生成）
        fetch("/asr/voice-design-samples").then((r) => r.json()).then((d) => {
          if (!dead && d?.ok && Array.isArray(d.samples)) setVdSamples(d.samples);
        }).catch(() => {});
        // 自动检测本机 ASR 组件（不覆盖用户已保存的配置，只静默记录）
        fetch("/asr/detect").then((r) => r.json()).then((d) => {
          if (!dead && d?.ok && d.detected?.serviceOk) {
            // 服务可达时静默确保 url 已填
          }
        }).catch(() => {});
        return () => { dead = true; if (previewRef.current !== null) previewRef.current.pause(); };
      }, []);

      // 自动保存的 setEngine（勾选/输入变化后立即持久化，防止刷新丢失；无保存按钮）
      // [本地改造 2026-08-21] 保存后以服务端返回的 config 为准刷新本地 state——
      // 避免"前端旧 config 全量覆盖服务端新变更"（如服务端新加的克隆样本被清空）
      const saveTimerRef = useRef(null);
      const setEngine = (key, patch, autoSave) => {
        setConfig((c) => {
          if (c === null) return c;
          const next = { ...c, engines: { ...c.engines, [key]: { ...c.engines[key], ...patch } } };
          if (autoSave) {
            if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
            saveTimerRef.current = window.setTimeout(() => {
              fetch("/voice-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: next }) })
                .then((r) => r.json())
                .then((d) => { if (d?.ok && d.config) setConfig(d.config); })
                .catch(() => {});
            }, 400);
          }
          return next;
        });
      };

      // [本地改造 2026-08-21] 克隆样本添加：选音频文件 → 校验格式/大小 → 上传命名
      const addCloneSample = async (file) => {
        if (file === null || file === undefined) return;
        setCloneAddMsg(null);
        if (!/\.(mp3|wav)$/i.test(file.name) && !/audio\/(mpeg|wav)/.test(file.type)) {
          setCloneAddMsg({ ok: false, text: "仅支持 mp3 / wav 格式" });
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          setCloneAddMsg({ ok: false, text: "音频需在 10MB 以内（官方限制；参考语音建议 15-60 秒，越长克隆越准）" });
          return;
        }
        const reader = new FileReader();
        const data = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        setAddingClone(true);
        try {
          const r = await fetch("/voice-config/voice-clone/add", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: cloneName.trim() !== "" ? cloneName.trim() : file.name.replace(/\.(mp3|wav)$/i, ""),
              audioBase64: data,
              mediaType: file.type || "audio/wav",
            }),
          });
          const d = await r.json();
          if (d?.ok) {
            setCloneAddMsg({ ok: true, text: "已添加克隆音色「" + d.sample.name + "」，如需默认使用，在「默认语音引擎」选「小米克隆」即可" });
            setCloneName("");
            // [本地改造 2026-08-21] 以服务端返回的 config 为准刷新（含新增样本），避免本地拼装丢字段
            if (d.config) setConfig(d.config);
          } else {
            setCloneAddMsg({ ok: false, text: d?.error ?? "添加失败" });
          }
        } catch (e) {
          setCloneAddMsg({ ok: false, text: String(e?.message ?? e) });
        }
        setAddingClone(false);
        if (cloneFileRef.current !== null) cloneFileRef.current.value = "";
      };

      // 音色试听：POST /voice-config/preview → 播放返回音频；tag 用于区分多个试听按钮状态；text/cmd/url 可临时指定
      // [2026-08-21] 失败时显示错误（之前静默无提示，用户填错 API Key 毫无反馈）
      const previewVoice = (engine, voice, context, samplePath, tag, extra) => {
        if (previewRef.current !== null) { previewRef.current.pause(); previewRef.current = null; }
        const curTag = tag ?? engine;
        previewTagRef.current = curTag;
        setPreviewing(curTag);
        setPreviewErr(null);
        fetch("/voice-config/preview", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            engine, voice: voice ?? undefined, context: context ?? undefined, samplePath: samplePath ?? undefined,
            text: extra?.text ?? undefined, cmd: extra?.cmd ?? undefined, url: extra?.url ?? undefined,
          }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d?.ok) { if (previewTagRef.current === curTag) setPreviewing(null); setPreviewErr(d?.error ?? "试听失败"); return; }
            if (previewTagRef.current !== curTag) return; // 已被「再点=停止」或切换，丢弃
            const audio = new Audio("data:" + d.mediaType + ";base64," + d.data);
            previewRef.current = audio;
            audio.onended = () => { if (previewTagRef.current === curTag) setPreviewing(null); };
            audio.onerror = () => {
              if (previewTagRef.current === curTag) {
                setPreviewing(null);
                setPreviewErr("音频加载/播放失败（服务可能返回了无效音频）");
              }
            };
            audio.play().catch(() => {
              if (previewTagRef.current === curTag) {
                setPreviewing(null);
                setPreviewErr("音频加载/播放失败（服务可能返回了无效音频）");
              }
            });
          })
          .catch((e) => { if (previewTagRef.current === curTag) setPreviewing(null); setPreviewErr(String(e?.message ?? e)); });
      };

      // [本地改造 2026-08-21] 试听克隆样本的原始音频（用于和克隆合成效果对比还原度）
      const previewSourceVoice = async (path, tag) => {
        if (previewRef.current !== null) { previewRef.current.pause(); previewRef.current = null; }
        previewTagRef.current = tag;
        setPreviewing(tag);
        try {
          const r = await fetch("/voice-config/voice-clone/source", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const d = await r.json();
          if (!d?.ok) { if (previewTagRef.current === tag) setPreviewing(null); return; }
          if (previewTagRef.current !== tag) return; // 已被「再点=停止」或切换，丢弃
          const audio = new Audio("data:" + d.mediaType + ";base64," + d.data);
          previewRef.current = audio;
          audio.onended = () => { if (previewTagRef.current === tag) setPreviewing(null); };
          audio.onerror = () => { if (previewTagRef.current === tag) setPreviewing(null); };
          audio.play().catch(() => { if (previewTagRef.current === tag) setPreviewing(null); });
        } catch { if (previewTagRef.current === tag) setPreviewing(null); }
      };

      const previewBtn = (tag, label, onClick, icon) => h("button", {
        type: "button", "aria-label": label, title: label,
        style: {
          border: "none", borderRadius: "6px", width: "30px", height: "30px", flex: "none",
          background: previewing === tag ? "rgba(229,72,77,.25)" : "rgba(128,128,128,.15)",
          color: "inherit", cursor: "pointer", fontSize: "13px",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        },
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => {
          // [本地改造 2026-08-21] 再点一次正在播放的按钮 = 停止（而不是重播）
          if (previewing === tag) {
            previewTagRef.current = null;
            if (previewRef.current !== null) { previewRef.current.pause(); previewRef.current = null; }
            setPreviewing(null);
            return;
          }
          onClick();
        },
      }, previewing === tag ? "⏹" : (icon ?? "🔊"));

      // 音色下拉 + 试听按钮（showPreview=false 时不显示试听，改由风格处试听）
      const voiceSelect = (engine, current, voices, onChange, showPreview) => h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
        h("select", { value: current, onChange: (e) => onChange(e.target.value), style: vInput },
          (voices ?? [current]).map((v) => h("option", { key: v, value: v }, v))),
        showPreview === false ? null : previewBtn(engine, "试听此音色", () => previewVoice(engine, current)),
      );

      // ASR 示例音频：自动加载 host 提供的测试音频（可播放），识别则把它发给 /asr/transcribe
      const loadAsrSample = () => {
        fetch("/asr/sample").then((r) => r.json()).then((d) => {
          if (!d?.ok) { setAsrResult({ ok: false, text: d?.error ?? "示例音频加载失败" }); return; }
          asrSampleBase64Ref.current = d.data;
          if (asrAudioRef.current !== null) {
            asrAudioRef.current.src = "data:" + d.mediaType + ";base64," + d.data;
          }
        }).catch((e) => setAsrResult({ ok: false, text: String(e) }));
      };
      const recognizeAsrSample = () => {
        const sample = asrSampleBase64Ref.current;
        if (sample === null || sample === undefined) { setAsrResult({ ok: false, text: "示例音频加载中，请稍候" }); return; }
        setAsrResult({ ok: true, text: "识别中…", busy: true });
        fetch("/asr/transcribe", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ audioBase64: sample }),
        }).then((r) => r.json()).then((d) => {
          setAsrResult(d?.ok ? { ok: true, text: d.text } : { ok: false, text: d?.error ?? "识别失败" });
        }).catch((e) => setAsrResult({ ok: false, text: String(e) }));
      };

      // 检测本机 ASR（exe/模型/服务/ffmpeg），自动填入可用的地址或命令
      const detectAsr = () => {
        setAsrResult(null);
        fetch("/asr/detect").then((r) => r.json()).then((d) => {
          if (!d?.ok) { setAsrResult({ ok: false, text: d?.error ?? "检测失败" }); return; }
          const det = d.detected;
          const fills = [];
          if (det.serviceOk) {
            setEngine("asr", { mode: "service", url: "http://127.0.0.1:18790" }, true);
            fills.push("检测到本地常驻服务(18790)，已自动填入地址");
          }
          if (det.cmd !== "") {
            if (!det.serviceOk) setEngine("asr", { mode: "cmd", cmd: det.cmd }, true);
            else setEngine("asr", { cmd: det.cmd }, true);
            fills.push("已填入本地命令路径");
          }
          if (!det.exe) fills.push("未找到 sherpa-onnx，可点「一键安装」");
          if (!det.ffmpegOk) fills.push("未找到 ffmpeg，安装脚本会自动安装");
          setAsrResult({ ok: true, text: fills.length > 0 ? fills.join("；") : "未检测到本地 ASR 组件，请点「一键安装」" });
        }).catch((e) => setAsrResult({ ok: false, text: String(e) }));
      };
      // 一键安装：获取安装命令并显示（不自动写剪贴板，避免 uBlock 误报 ClickFix；用户手动复制更安全）
      const installAsr = () => {
        setAsrInstalling(true);
        setAsrCmd(null);
        fetch("/asr/install-script").then((r) => r.json()).then((d) => {
          setAsrInstalling(false);
          if (!d?.ok) { setAsrResult({ ok: false, text: d?.error ?? "获取安装命令失败" }); return; }
          setAsrCmd(d.command);
          setAsrResult({
            ok: true,
            text: "请打开「以管理员身份运行」的 PowerShell，手动复制下方命令粘贴执行。\n安装位置会自动放到插件目录：" + d.installDir + "\n脚本会自动下载 sherpa-onnx + SenseVoice 模型 + ffmpeg 并注册开机自启服务（端口 18790）",
          });
        }).catch((e) => { setAsrInstalling(false); setAsrResult({ ok: false, text: String(e) }); });
      };
      // [2026-08-21] 本地 TTS 一键安装：获取安装命令并显示（与 ASR 同款交互）
      const installLocalTts = () => {
        setTtsInstalling(true);
        setTtsCmd(null);
        fetch("/tts/install-script").then((r) => r.json()).then((d) => {
          setTtsInstalling(false);
          if (!d?.ok) { setTtsCmd(null); setPreviewErr(d?.error ?? "获取安装命令失败"); return; }
          setTtsCmd(d.command);
          setPreviewErr(null);
        }).catch((e) => { setTtsInstalling(false); setPreviewErr(String(e)); });
      };

      // 提示小问号（hover 浮层显示 / 点击固定）；align="right" 时浮层右对齐（向左展开，适合靠左按钮），默认左对齐（向右展开，适合靠右按钮）
      const helpTip = (text, pinned, setPinned, hover, setHover, align, place) => h("span", { style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        h("button", {
          type: "button", "aria-label": "帮助", title: "帮助",
          style: {
            border: "none", borderRadius: "999px", width: "18px", height: "18px", padding: "0",
            background: pinned ? "var(--vk-accent,#4b6fff)" : "rgba(128,128,128,.15)",
            color: "inherit", cursor: "pointer", fontSize: "10px", fontWeight: 700,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          },
          onMouseDown: (e) => e.preventDefault(),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: () => { setPinned(!pinned); setHover(false); },
        }, "?"),
        (pinned || hover) ? h("div", {
          style: {
            position: "absolute", ...(place === "top" ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }), zIndex: 60,
            ...(align === "right" ? { right: "0", left: "auto" } : align === "center" ? { left: "50%", transform: "translateX(-50%)" } : { left: "0", right: "auto" }),
            background: "var(--dsw-specific-input-fill,#1e2128)",
            border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px",
            padding: "10px 12px", boxShadow: "0 8px 24px rgba(0,0,0,.35)",
            fontSize: "12px", lineHeight: "1.7", color: "var(--dsw-alias-label-secondary,#9aa3ad)",
            minWidth: "320px", maxWidth: "460px",
          },
        }, text) : null,
      );

      if (config === null) {
        return h("div", { style: { padding: "16px", fontSize: "13px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "语音配置加载中…");
      }
      const eng = config.engines;
      const cloneSamples = Array.isArray(eng.voiceclone.samples) ? eng.voiceclone.samples : [];
      const showRules = rulesPinned || rulesHover;
      // [本地改造 2026-08-21] 已移除 VoiceClone/VoiceDesign 勾选：分区始终显示
      const designOn = false;
      const cloneOn = false;

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px", padding: "16px", width: "100%", boxSizing: "border-box" } },
        // 分区标题（语音图标已移到各服务商卡片前）
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "15px", fontWeight: 700, color: "var(--dsw-alias-label-primary,#e6e9ef)" } },
          "语音服务"),
        // [2026-08-21] 试听失败错误提示；[2026-08-22] fixed 顶部弹窗 Toast + 限高滚动（错误堆栈超长不撑爆）
        previewErr !== null ? h("div", {
          style: {
            position: "fixed", top: "24px", left: "50%", transform: "translateX(-50%)", zIndex: 9999,
            background: "rgba(229,72,77,.95)", color: "#fff", borderRadius: "10px",
            padding: "10px 18px", fontSize: "13px", lineHeight: "1.5",
            boxShadow: "0 6px 24px rgba(0,0,0,.45)",
            maxWidth: "520px", maxHeight: "45vh", overflowY: "auto",
            whiteSpace: "pre-wrap", wordBreak: "break-word", pointerEvents: "none",
          },
        }, "试听失败：" + previewErr) : null,
        // [2026-08-21] 语音能力状态面板（安装即用 vs dsh 原生契约支持）
        caps !== null ? h("div", { style: { border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "6px", background: "rgba(128,128,128,.05)", fontSize: "12.5px", lineHeight: "1.5" } },
          h("div", { style: { fontSize: "12px", fontWeight: 600, opacity: .8 } }, "语音能力"),
          h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
            h("span", { style: { color: "#3ecf8e" } }, "✅"), " 语音输入（录音+识别+发送）", h("span", { style: { marginLeft: "auto", opacity: .7 } }, "插件自带")),
          h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
            h("span", { style: { color: "#3ecf8e" } }, "✅"), " 聊天语音气泡（可点播放）", h("span", { style: { marginLeft: "auto", opacity: .7 } }, "插件内置")),
          h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
            caps.voiceContentContract === true
              ? h("span", { style: { color: "#3ecf8e" } }, "✅")
              : h("span", { style: { color: "#e5a53a" } }, "⚠️"),
            " dsh 原生语音消息（多模态直发）",
            h("span", { style: { marginLeft: "auto", opacity: .7 } },
              caps.voiceContentContract === true ? "当前 dsh 支持" : "当前 dsh 不支持，自动转文字发送")),
          caps.voiceContentContract === true ? null : h("div", { style: { fontSize: "12px", opacity: .75, marginTop: "2px" } },
            "说明：当前 dsh（npm 安装版）契约不支持原生语音消息，语音自动转文字发送，AI 通过【用户语音】标记识别。原生语音消息需使用「含语音改造的 dsh」——注意：官方源码/官方发布版均无此功能，语音能力是语音插件配套的 dsh 本地改造（本机 lecoo 的 dev 仓库即为改造版），正整理提交官方。"),
        ) : null,
        // ⑤ ASR 语音识别（必填项，无开关）
        h("div", { style: { border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px", background: "rgba(128,128,128,.05)" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
            h("span", { style: { display: "inline-flex", width: "22px", height: "22px", borderRadius: "6px", background: "rgba(128,128,128,.12)", alignItems: "center", justifyContent: "center", color: "var(--vk-accent,#4b6fff)", flex: "none" } }, micIcon),
            h("span", { style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "ASR 语音识别"),
            helpTip("把语音转成文字（必填配置，选一种模式即可）。本地服务：请求常驻 HTTP 服务（默认 127.0.0.1:18790）；本地命令：直接调用 sherpa-onnx exe，无需额外装服务，速度与本地服务基本一致（8 秒音频约 1.4s，其中真正推理只占 0.16s，其余是每次加载模型的固定开销）；在线 API：走 OpenAI 兼容接口，不占用本地算力。", asrTipPinned, setAsrTipPinned, asrTipHover, setAsrTipHover, "center"),
          ),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
              vField("模式", h("select", {
                value: eng.asr.mode ?? "service",
                onChange: (e) => setEngine("asr", { mode: e.target.value }, true),
                style: vInput,
              },
                h("option", { value: "service" }, "本地常驻服务"),
                h("option", { value: "cmd" }, "本地命令"),
                h("option", { value: "api" }, "在线 API"))),
              (eng.asr.mode ?? "service") === "service" ? vField("本地服务地址", h("input", { value: eng.asr.url ?? "", onChange: (e) => setEngine("asr", { url: e.target.value }, true), placeholder: "http://127.0.0.1:18790", style: vInput })) : null,
              (eng.asr.mode ?? "service") === "cmd" ? vField("本地命令", h("input", { value: eng.asr.cmd ?? "", onChange: (e) => setEngine("asr", { cmd: e.target.value }, true), placeholder: "sherpa-onnx-offline.exe --tokens=... --sense-voice-model=... --num-threads=4", style: vInput })) : null,
              (eng.asr.mode ?? "service") === "api" ? [
                secretField("API Key", "asr", eng.asr.apiKey ?? "", (e) => setEngine("asr", { apiKey: e.target.value }, true), "sk-..."),
                vField("API 地址", h("input", { value: eng.asr.apiBaseUrl ?? "", onChange: (e) => setEngine("asr", { apiBaseUrl: e.target.value }, true), placeholder: "https://api.openai.com/v1", style: vInput })),
              ] : null,
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
              h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", flex: "none" } }, "示例音频："),
              h("audio", { ref: asrAudioRef, controls: true, preload: "none", style: { maxWidth: "320px", height: "32px", flex: "none" } }),
              h("button", {
                type: "button",
                style: {
                  border: "none", borderRadius: "999px", padding: "7px 16px", fontSize: "12.5px", fontWeight: 600,
                  background: asrResult?.busy ? "rgba(229,72,77,.85)" : "rgba(128,128,128,.15)",
                  color: "inherit", cursor: "pointer",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: recognizeAsrSample,
              }, asrResult?.busy ? "识别中…" : "识别这段音频"),
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
              h("button", {
                type: "button",
                style: {
                  border: "1px solid var(--vk-accent,#4b6fff)", borderRadius: "999px", padding: "6px 16px",
                  fontSize: "12.5px", fontWeight: 600, background: "transparent", color: "var(--vk-accent,#4b6fff)",
                  cursor: "pointer",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: detectAsr,
              }, "检测已安装"),
              h("button", {
                type: "button",
                style: {
                  border: "none", borderRadius: "999px", padding: "6px 16px", fontSize: "12.5px", fontWeight: 600,
                  background: asrInstalling ? "rgba(128,128,128,.15)" : "var(--vk-accent,#4b6fff)",
                  color: "#fff", cursor: "pointer",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: installAsr,
              }, asrInstalling ? "准备命令…" : "复制安装命令"),
              h("span", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } },
                "复制命令后，打开「以管理员身份运行」的 PowerShell 粘贴执行。脚本自动下载 sherpa-onnx + SenseVoice 模型 + ffmpeg 并注册开机自启服务，安装到插件目录内统一路径"),
            ),
            asrCmd !== null ? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
              h("div", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "安装命令（点击选中全部，Ctrl+C 复制）："),
              h("code", {
                style: {
                  display: "block", fontSize: "12px", lineHeight: "1.6", fontFamily: "Consolas, monospace",
                  color: "var(--dsw-alias-label-primary,#e6e9ef)",
                  border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px",
                  padding: "8px 10px", background: "rgba(128,128,128,.08)",
                  wordBreak: "break-all", whiteSpace: "pre-wrap", cursor: "text", userSelect: "all",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: (e) => {
                  const sel = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(e.currentTarget);
                  sel.removeAllRanges();
                  sel.addRange(range);
                },
              }, asrCmd),
            ) : null,
            asrResult !== null && asrResult.text !== undefined ? h("div", {
              style: {
                fontSize: "12.5px", lineHeight: "1.6",
                color: asrResult.ok ? "var(--dsw-alias-label-primary,#e6e9ef)" : "#e5484d",
                border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px", padding: "8px 10px",
                background: "rgba(128,128,128,.06)", whiteSpace: "pre-wrap",
              },
            }, asrResult.text) : null,
          ),
        ),
        // 默认引擎
        vField("默认语音引擎", h("select", {
          value: config.defaultEngine,
          onChange: (e) => {
            // [本地改造 2026-08-21] 修复：defaultEngine 之前只改本地 state 不持久化，刷新回 auto；
            // 现在与其它字段一致：防抖 POST 立即保存
            const next = { ...config, defaultEngine: e.target.value };
            setConfig(next);
            if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
            saveTimerRef.current = window.setTimeout(() => {
              fetch("/voice-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: next }) }).catch(() => {});
            }, 400);
          },
          style: vInput,
        },
          ["auto", ...ENGINES_ORDER].map((k) => h("option", { key: k, value: k },
            k === "auto" ? "auto（按规则自动选择，未启用任何引擎时用微软 edge 免费兜底）"
              : k === "voiceclone"
                ? "小米克隆（VoiceClone）" + (cloneSamples.length > 0 ? "：默认用「" + cloneSamples[0].name + "」" : "（未添加样本）")
                : ENGINE_LABELS[k])))),
        // 语音三原则：问号按钮（hover 显示，点击固定/收起）
        h("div", { style: { position: "relative", display: "inline-flex", alignItems: "center", gap: "6px" } },
          h("button", {
            type: "button", "aria-label": "语音自动回复规则", title: "语音自动回复规则",
            style: {
              border: "none", borderRadius: "999px", width: "22px", height: "22px", padding: "0",
              background: rulesPinned ? "var(--vk-accent,#4b6fff)" : "rgba(128,128,128,.15)",
              color: "inherit", cursor: "pointer", fontSize: "12px", fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            },
            onMouseDown: (e) => e.preventDefault(),
            onMouseEnter: () => setRulesHover(true),
            onMouseLeave: () => setRulesHover(false),
            onClick: () => setRulesPinned((v) => !v),
          }, "?"),
          h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "语音自动回复规则", rulesPinned ? "（已固定，点击收起）" : "（悬停查看，点击固定）"),
          showRules ? h("div", {
            style: {
              position: "absolute", top: "calc(100% + 6px)", left: "0", zIndex: 30,
              background: "var(--dsw-specific-input-fill,#1e2128)",
              border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px",
              padding: "10px 12px", boxShadow: "0 8px 24px rgba(0,0,0,.35)",
              fontSize: "12px", lineHeight: "1.8", color: "var(--dsw-alias-label-secondary,#9aa3ad)",
              minWidth: "360px", maxWidth: "480px",
            },
          }, VOICE_RULES.map((r) => h("div", { key: r }, r))) : null,
        ),
        // ① edge
        vCard(ENGINE_LABELS.edge, openCards.edge, () => toggleCard("edge"),
          vField("音色", voiceSelect("edge", eng.edge.voice, meta?.edgeVoices, (v) => setEngine("edge", { voice: v }, true)))),
        // ② 小米 MiMo（三模型合一卡片）
        vCard(h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          ENGINE_LABELS.xiaomi,
          helpTip("想让 AI 唱歌？直接对 AI 说“唱首歌/用歌声回我”，回复时自动加 (唱歌) 标签。", xmTipPinned, setXmTipPinned, xmTipHover, setXmTipHover),
          h("span", { style: { fontSize: "12px", fontWeight: 400, color: "var(--dsw-alias-label-secondary,#9aa3ad)" } },
            "（限时免费，请以官方为准）",
            h("a", {
              href: MIMO_DOC_URL, target: "_blank", rel: "noreferrer",
              style: { color: "var(--vk-accent,#4b6fff)", textDecoration: "none" },
            }, "MiMo 官方模型页"),
          ),
        ), openCards.xiaomi, () => toggleCard("xiaomi"),
          () => h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
            // [本地改造 2026-08-21] API Key（卡片最上；不再有模型勾选）
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
              secretField("API Key", "xiaomi", eng.xiaomi.apiKey, (e) => setEngine("xiaomi", { apiKey: e.target.value }, true),
                (eng.xiaomi.apiKey !== "" || meta?.envKeys?.xiaomi) ? "已填写——输入新值可替换" : "MIMO_API_KEY"),
            ),
            // 语音模型：MiMo-V2.5-TTS（基础 TTS，音色 + 语言风格）
            h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
                h("span", { style: { fontSize: "12.5px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "语音模型：MiMo-V2.5-TTS"),
              ),
              h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
                vField("音色", voiceSelect("xiaomi", eng.xiaomi.voice, meta?.xiaomiVoices, (v) => setEngine("xiaomi", { voice: v }, true), false)),
                vField("默认语言风格", h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
                  h("select", {
                    value: STYLE_PRESETS.find((sp) => sp.ctx === (eng.xiaomi.context ?? ""))?.key ?? "",
                    onChange: (e) => {
                      const hit = STYLE_PRESETS.find((sp) => sp.key === e.target.value);
                      setEngine("xiaomi", { context: hit ? hit.ctx : "" }, true);
                    },
                    style: { ...vInput, flex: 1 },
                  },
                    STYLE_PRESETS.map((sp) => h("option", { key: sp.key || "nat", value: sp.key }, sp.label))),
                  previewBtn("style", "试听", () => previewVoice("xiaomi", eng.xiaomi.voice, eng.xiaomi.context ?? "", undefined, "style")),
                )),
              ),
            ),
            // 克隆模型：MiMo-V2.5-TTS-VoiceDesign（官方示例，始终显示）
            h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
                h("span", { style: { fontSize: "12.5px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "克隆模型：MiMo-V2.5-TTS-VoiceDesign"),
                helpTip("「音色设计 VoiceDesign」由 AI 根据对话情境自动编写音色描述（无需你填写）：比如你说「用低沉的声音念这首诗」，AI 会自己写一段音色描述（年龄段+性别+质感+语速+情绪）再念。开启后 AI 还会自觉用语音表达情绪：任务成功时兴奋道喜、你生气时委屈道歉、你难过时温柔安慰等。下方示例是官方效果，点播放即可试听。", designTipPinned, setDesignTipPinned, designTipHover, setDesignTipHover, "center", "top"),
              ),
              h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "官方示例"),
              VOICE_DESIGN_EXAMPLES.map((ex, i) => h("div", { key: ex.title, style: { border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px", padding: "8px 10px", display: "flex", flexDirection: "column", gap: "6px" } },
                h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
                  h("span", { style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)", flex: "none" } }, ex.title),
                  helpTip(
                    h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
                      h("div", null, h("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "Instruct："), ex.instruct),
                      h("div", null, h("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "Text："), ex.text),
                    ),
                    vdExamplePins[i], (v) => { const n = [...vdExamplePins]; n[i] = v; setVdExamplePins(n); },
                    vdExampleHovers[i], (v) => { const n = [...vdExampleHovers]; n[i] = v; setVdExampleHovers(n); },
                    "left", "top",
                  ),
                ),
                h("audio", {
                  controls: true, preload: "none",
                  src: vdSamples[i] !== undefined ? "data:" + vdSamples[i].mediaType + ";base64," + vdSamples[i].data : undefined,
                  style: { width: "100%", height: "32px" },
                }),
              )),
            ),
            // 克隆模型：MiMo-V2.5-TTS-VoiceClone（样本管理，始终显示）
            h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
                h("span", { style: { fontSize: "12.5px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "克隆模型：MiMo-V2.5-TTS-VoiceClone"),
                helpTip("克隆音色与预置音色（冰糖等）互斥：在「默认语音引擎」里选择「小米克隆（VoiceClone）」后，默认回复一律使用下方克隆声音；开启 VoiceDesign 时，AI 会在克隆底嗓上叠加情感指令（如「用委屈撒娇的语气」），克隆声同样带情感。", cloneListTipPinned, setCloneListTipPinned, cloneListTipHover, setCloneListTipHover, "center", "top"),
              ),
              cloneSamples.length > 0 ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
                h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "已保存的克隆音色："),
                cloneSamples.map((sp) => h("div", { key: sp.id, style: { display: "flex", alignItems: "center", gap: "8px", border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px", padding: "6px 10px", fontSize: "12.5px" } },
                    h("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)", flex: "none" } }, sp.name ?? "样本"),
                    h("span", { style: { color: "var(--dsw-alias-label-secondary,#9aa3ad)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } }, sp.path ?? ""),
                    previewBtn("clone:" + sp.id, "试听克隆合成效果（统一文本）", () => previewVoice("voiceclone", undefined, undefined, sp.path, "clone:" + sp.id, { text: CLONE_PREVIEW_TEXT })),
                    previewBtn("clone-src:" + sp.id, "试听原始音频（对比克隆还原度）", () => previewSourceVoice(sp.path, "clone-src:" + sp.id), "▶"),
                    h("button", {
                      type: "button", "aria-label": "删除", title: "删除此克隆音色",
                      style: { border: "none", borderRadius: "6px", width: "28px", height: "28px", flex: "none", background: "rgba(229,72,77,.15)", color: "#e5484d", cursor: "pointer", fontSize: "14px" },
                      onMouseDown: (e) => e.preventDefault(),
                      onClick: () => setEngine("voiceclone", { samples: cloneSamples.filter((x) => x.id !== sp.id) }, true),
                    }, "✕"),
                  )),
              ) : h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", lineHeight: 1.7 } },
                "无（尚未添加克隆音色）。",
              ),
              // [本地改造 2026-08-21] 添加克隆音色：选音频 → 命名 → 上传
              h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
                h("div", { style: { fontSize: "12.5px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "添加克隆音色"),
                h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "支持 mp3 / wav，Base64 后 ≤10MB（官方限制）；参考语音建议 15-60 秒、单人纯人声无背景音乐，越长克隆越准。"),
                h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
                  vField("名称", h("input", { value: cloneName, onChange: (e) => setCloneName(e.target.value), placeholder: "如：我的声音（留空用文件名）", style: { ...vInput, width: "100%" } })),
                  h("button", {
                    type: "button", onClick: () => cloneFileRef.current?.click(), disabled: addingClone,
                    style: { background: "var(--vk-accent,#4b6fff)", color: "#fff", border: "none", borderRadius: "999px", padding: "7px 16px", fontSize: "12.5px", fontWeight: 600, cursor: "pointer", flex: "none" },
                  }, addingClone ? "添加中…" : "选择音频文件添加"),
                  h("input", { ref: cloneFileRef, type: "file", accept: ".mp3,.wav,audio/mpeg,audio/wav", style: { display: "none" }, onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f !== undefined && f !== null) void addCloneSample(f); } }),
                ),
                cloneAddMsg !== null ? h("div", { style: { fontSize: "12px", color: cloneAddMsg.ok ? "#73c991" : "#f14c4c" } }, cloneAddMsg.text) : null,
              ),
            ),
          )),
        // ③ 本地 TTS（与其他卡片一致：勾选后才显示配置字段）
        vCard(h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          ENGINE_LABELS.local,
          helpTip("本地模型常驻内存（CPU 推理）。填本地命令（每次调用启动进程，较慢）；或填 HTTP 服务地址（推荐，模型常驻一次加载后快）。两者都填时 HTTP 优先；留空则跳过本地引擎。点「复制安装命令」可一键下载 sherpa-onnx + 中文 MeloTTS 模型 + ffmpeg，并自动生成可用的启动脚本。", localTipPinned, setLocalTipPinned, localTipHover, setLocalTipHover, "center"),
        ), openCards.local, () => toggleCard("local"),
          [
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
              vField("本地命令（每次调用启动进程）", h("input", { value: eng.local.cmd ?? "", onChange: (e) => setEngine("local", { cmd: e.target.value }, true), placeholder: "如 node <插件目录>\\local-tts.mjs（安装脚本会自动填好）", style: vInput })),
              vField("HTTP 服务地址（常驻模式）", h("input", { value: eng.local.url ?? "", onChange: (e) => setEngine("local", { url: e.target.value }, true), placeholder: "如 http://127.0.0.1:5000/tts（POST {text} 返回音频）", style: vInput })),
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
              previewBtn("local-preview", "试听本地 TTS", () => previewVoice("local", undefined, undefined, undefined, "local-preview", { cmd: eng.local.cmd ?? "", url: eng.local.url ?? "" })),
              h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "点击试听（用上方填的命令/地址合成）"),
            ),
            // [2026-08-21] 本地 TTS 一键安装（与 ASR 同款交互）
            h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
              h("button", {
                type: "button",
                style: {
                  border: "none", borderRadius: "999px", padding: "6px 16px", fontSize: "12.5px", fontWeight: 600,
                  background: ttsInstalling ? "rgba(128,128,128,.15)" : "var(--vk-accent,#4b6fff)",
                  color: "#fff", cursor: "pointer",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: installLocalTts,
              }, ttsInstalling ? "准备命令…" : "复制安装命令"),
              h("span", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } },
                "复制命令后，打开「以管理员身份运行」的 PowerShell 粘贴执行。脚本自动下载 sherpa-onnx（含离线 TTS）+ 中文 MeloTTS 模型 + ffmpeg，并生成 local-tts.mjs 启动脚本"),
            ),
            ttsCmd !== null ? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
              h("div", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "安装命令（点击选中全部，Ctrl+C 复制）："),
              h("code", {
                style: {
                  display: "block", fontSize: "12px", lineHeight: "1.6", fontFamily: "Consolas, monospace",
                  color: "var(--dsw-alias-label-primary,#e6e9ef)",
                  border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px",
                  padding: "8px 10px", background: "rgba(128,128,128,.08)",
                  wordBreak: "break-all", whiteSpace: "pre-wrap", cursor: "text", userSelect: "all",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: (e) => {
                  const sel = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(e.currentTarget);
                  sel.removeAllRanges();
                  sel.addRange(range);
                },
              }, ttsCmd),
            ) : null,
          ]),
        // ④ 阿里 qwen3-tts
        vCard(ENGINE_LABELS.ali, openCards.ali, () => toggleCard("ali"),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
            secretField("API Key", "ali", eng.ali.apiKey ?? "", (e) => setEngine("ali", { apiKey: e.target.value }, true),
              (eng.ali.apiKey !== "" || meta?.envKeys?.ali) ? "已填写——输入新值可替换" : "dashscope API Key"),
            vField("音色", voiceSelect("ali", eng.ali.voice ?? "Cherry", meta?.aliVoices, (v) => setEngine("ali", { voice: v }, true))),
          )),
      );
    }

    // ── [本地改造 2026-08-21] 语音条尾部「复制转写」按钮 ─────────────
    // 挂在 conversation.chat.voice-actions 槽（核心补的挂点）：按钮渲染在语音条
    // （VoiceCard）内部、转写文本之后，样式对齐系统复制按钮（28px 圆形透明、
    // hover 变背景；图标 14px）。
    const actionCopySvg = h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
      h("rect", { x: "5.5", y: "5.5", width: "7", height: "7", rx: "1.2", fill: "none", stroke: "currentColor", strokeWidth: "1.3" }),
      h("path", { d: "M10.5 5.5V4.5A1 1 0 0 0 9.5 3.5H5A1 1 0 0 0 4 4.5v4.5a1 1 0 0 0 1 1h1", fill: "none", stroke: "currentColor", strokeWidth: "1.3" }),
    );
    const actionCheckSvg = h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
      h("path", { d: "M3.5 8.5L6.5 11.5L12.5 4.5", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }),
    );
    function VoiceCopyTranscriptAction(props) {
      const transcript = props.transcript;
      const [copied, setCopied] = react.useState(false);
      if (typeof transcript !== "string" || transcript === "") return null;
      const onCopy = () => {
        const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
        if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(transcript).then(done, done);
        } else { done(); }
      };
      const label = copied ? "已复制转写文本" : "复制转写文本";
      const style = {
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: "28px", height: "28px", padding: "6px", border: "none",
        borderRadius: "28px", background: "transparent",
        color: "var(--dsw-alias-label-tertiary)", cursor: "pointer",
        flexShrink: 0,
      };
      return h("button", {
        type: "button",
        onClick: onCopy,
        title: label,
        "aria-label": label,
        style,
        onMouseEnter: (e) => {
          e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover)";
          e.currentTarget.style.color = "var(--dsw-alias-label-secondary)";
        },
        onMouseLeave: (e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--dsw-alias-label-tertiary)";
        },
      }, copied ? actionCheckSvg : actionCopySvg);
    }

    const inject = ["slots"];

    function apply(ctx) {
      const getConnection = () => ctx.get("connection");
      ctx.effect(() => {
        const disposers = [
          // 附件槽：priority:-1 覆盖官方（lowest renders；官方默认 0 不冲突）
          ctx.slots.inject("conversation.input.attachments", () => ctx.slots.register({
            name: "conversation.input.attachments",
            id: "composer-attachments-overlay",
            priority: -1,
            locale: "conversation",
            inject: (sessionId) => ({ connection: getConnection(), sessionId }),
          }, ComposerAttachmentsOverlay)),
          ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
            name: "conversation.input.left",
            id: "composer-left",
            order: 10,
            locale: "conversation",
            inject: (sessionId) => ({ connection: getConnection(), sessionId }),
          }, ToolbarLeft)),
          ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
            name: "conversation.input.right",
            id: "composer-balance",
            order: -10,
            locale: "conversation",
            inject: (sessionId) => ({ connection: getConnection(), sessionId }),
          }, BalanceMeter)),
          // 设置页「语音服务」分区（settings.section 槽）
          ctx.slots.inject("settings.section", () => ctx.slots.register({
            name: "settings.section",
            id: "voice",
            order: 4,
            label: () => "语音服务",
          }, VoiceSettingsSection)),
          // [本地改造 2026-08-21] 语音条尾部「复制转写」按钮（voice-actions 槽，
          // 渲染在语音卡内转写文本之后；样式对齐系统复制按钮）
          ctx.slots.inject("conversation.chat.voice-actions", () => ctx.slots.register({
            name: "conversation.chat.voice-actions",
            id: "voice-copy-transcript",
            order: 0,
          }, VoiceCopyTranscriptAction)),
        ];
        return () => { for (const d of disposers) d(); };
      }, "dsh-input-tools: toolbar");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});