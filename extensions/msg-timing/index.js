/**
 * Message Timing Plugin
 * 
 * On inbound: records the time the server received the message.
 * On outbound: appends a server-side timing block to the reply
 * (receive time, send time, latency) before delivery to the user.
 * The model never sees this — it is added by the plugin.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const LOG = "/tmp/msg-timing.log";
const RECV_FILE = "/tmp/msg-timing-recv.json";

function log(prefix, extra = "") {
  const now = new Date();
  const timeStr = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const ts = now.getTime();
  try {
    appendFileSync(LOG, `${prefix} ${timeStr} | ${ts} ${extra}\n`);
  } catch(e) {}
}

function nowStr() {
  const d = new Date();
  return {
    time: d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    ts: d.getTime()
  };
}

function fmtTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function getLastReceiveTs() {
  try {
    if (!existsSync(RECV_FILE)) return null;
    const content = readFileSync(RECV_FILE, "utf8").trim();
    if (!content) return null;
    // 找最后一行
    const lines = content.split("\n").filter(Boolean);
    const last = lines[lines.length - 1];
    const obj = JSON.parse(last);
    return obj.receiveTs;
  } catch(e) {
    return null;
  }
}

function clearRecv() {
  try { writeFileSync(RECV_FILE, ""); } catch(e) {}
}

export default {
  id: "msg-timing",
  name: "Message Timing Plugin",
  register(api) {
    // ============ 收到消息时记录 ============
    api.on("message_received", (event, ctx) => {
      const { ts } = nowStr();
      const channel = ctx?.channelId || event?.from?.channelId || "unknown";
      // 用 to（发送者）作 key 持久化
      const convKey = event?.to || event?.from?.userId || event?.senderId || "default";
      try {
        writeFileSync(RECV_FILE, JSON.stringify({
          convKey,
          channel,
          receiveTs: ts,
          messageId: event?.messageId,
          preview: (event?.content || "").slice(0, 50)
        }) + "\n");
      } catch(e) {}
      log("[IN]", `| channel=${channel} | ts=${ts}`);
    });

    // ============ 准备发送回复时 ============
    api.on("message_sending", (event, ctx) => {
      const { ts: sendTs } = nowStr();
      const channel = ctx?.channelId || event?.metadata?.channelId || "unknown";
      // event.to 是接收方（即用户），应该跟 message_received 时一致
      const to = event?.to;

      // 找匹配的 IN 记录
      let receiveTs = null;
      try {
        if (existsSync(RECV_FILE)) {
          const content = readFileSync(RECV_FILE, "utf8").trim();
          if (content) {
            const lines = content.split("\n").filter(Boolean);
            // 倒序找匹配 to 的
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const obj = JSON.parse(lines[i]);
                if (to && obj.convKey === to) {
                  receiveTs = obj.receiveTs;
                  break;
                }
              } catch(e) {}
            }
            // 兜底：没匹配就用最后一条
            if (receiveTs == null) {
              const obj = JSON.parse(lines[lines.length - 1]);
              receiveTs = obj.receiveTs;
            }
          }
        }
      } catch(e) {}

      if (receiveTs == null) receiveTs = sendTs;
      const latencyMs = Math.max(0, sendTs - receiveTs);
      const latencySec = (latencyMs / 1000).toFixed(3);
      const receiveTime = fmtTime(receiveTs);
      const sendTimeStr = fmtTime(sendTs);

      // 构建时间块
      const block =
        `\n\n---\n[收到] ${receiveTime}\n[发送] ${sendTimeStr}\n[耗时] ${latencySec}s`;

      // 改写 content（message_sending event 字段是 {to, content, metadata}）
      if (typeof event?.content === "string" && event.content.length > 0) {
        event.content = event.content + block;
      }

      log("[OUT]", `| channel=${channel} | recv=${receiveTime} | send=${sendTimeStr} | latency=${latencySec}s | to=${to || "?"}`);

      // 发送完成后清空 recv（防 stale）
      // 但不在这清，因为 message_sending 可能在重试/多次触发
      // clearRecv();
    });
  }
};
