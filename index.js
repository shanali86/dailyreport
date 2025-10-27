import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

import { saveUserReport, startCronJobs, setLarkToken } from "./dailyreport.js";

const app = express();
app.use(bodyParser.json());

// App config
const APP_ID = "cli_a88d2a3f59f85028";
const APP_SECRET = "Xj5Im0dAGzSehhDAM8gG7fzRi80W3Zm1";

let LARK_BOT_TOKEN = "";

// ------------------- HELPER: validate report format ------------------- //
function parseReportText(rawText) {
  // expected keys
  // 📅 Date:
  // 🧾 Today’s Work Summary:
  // ⏳ Pending Work or Reason:
  // 💡 Git Push:

  // we'll support both emoji labels and plain english fallback just in case
  const dateMatch = rawText.match(/Date:\s*(.+)/i);
  const summaryMatch = rawText.match(/Work\s*Summary:\s*([\s\S]*?)\n/iu) ||
                        rawText.match(/Today.?s Work Summary:\s*([\s\S]*?)\n/iu);
  const pendingMatch = rawText.match(/Pending Work(?: or Reason)?:\s*([\s\S]*?)\n/iu);
  const gitMatch = rawText.match(/Git Push:\s*(.+)/i);

  if (!dateMatch || !summaryMatch || !pendingMatch || !gitMatch) {
    return null;
  }

  return {
    date: dateMatch[1].trim(),
    summary: summaryMatch[1].trim(),
    pending: pendingMatch[1].trim(),
    reason: pendingMatch[1].trim(), // we treat same text as reason for now
    gitPush: /yes|true|pushed/i.test(gitMatch[1]),
  };
}

// ------------------- REFRESH TOKEN ------------------- //
async function refreshToken() {
  console.log("🔄 Refreshing Lark token...");
  const res = await fetch(
    "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    }
  );

  const data = await res.json();
  if (data.code === 0 && data.tenant_access_token) {
    LARK_BOT_TOKEN = data.tenant_access_token;
    console.log("✅ Lark token refreshed successfully!");
    // tell dailyreport.js also
    setLarkToken(LARK_BOT_TOKEN);
  } else {
    console.error("❌ Token refresh failed:", data);
  }
}

// ------------------- REPLY TO USER (thread reply) ------------------- //
async function replyToMessage(originalMsgId, text) {
  const replyPayload = {
    msg_type: "text",
    content: JSON.stringify({ text }),
  };

  const replyUrl = `https://open.larksuite.com/open-apis/im/v1/messages/${originalMsgId}/reply`;

  const replyRes = await fetch(replyUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LARK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(replyPayload),
  });

  const replyData = await replyRes.json();
  console.log("📤 Reply Response:", replyData);
}

// ------------------- WEBHOOK ------------------- //
app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Lark URL verification
  if (body && body.type === "url_verification") {
    console.log("🔗 URL verification challenge received:", body.challenge);
    return res.status(200).json({ challenge: body.challenge });
  }

  try {
    const event = body.event;
    if (!event || !event.message) {
      return res.status(200).send("no event");
    }

    const msg = event.message;
    const sender = event.sender;
    const userId = sender?.sender_id?.user_id || sender?.sender_id?.open_id || "unknown_user";

    let textRaw = "";
    try {
      textRaw = JSON.parse(msg.content).text || "";
    } catch {
      textRaw = "";
    }

    console.log("📩 Message Received:", textRaw);

    // Try to parse as structured daily report
    const parsed = parseReportText(textRaw);

    if (parsed) {
      // valid format → save to Firestore
      await saveUserReport({
        username: userId, // you can replace with readable name later
        userId,
        date: parsed.date,
        summary: parsed.summary,
        pending: parsed.pending,
        reason: parsed.reason,
        gitPush: parsed.gitPush,
      });

      await replyToMessage(
        msg.message_id,
        "✅ Report saved in system. Thank you."
      );
    } else if (textRaw.toLowerCase().includes("report")) {
      // it's about report but WRONG format
      await replyToMessage(
        msg.message_id,
        "⚠️ Please send report in format:\n\n📅 Date: YYYY-MM-DD\n🧾 Today’s Work Summary: ...\n⏳ Pending Work or Reason: ...\n💡 Git Push: Yes/No"
      );
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Error handling event:", err);
    res.status(500).send("error");
  }
});

// ------------------- START SERVER ------------------- //
app.listen(3000, async () => {
  console.log("🚀 Lark webhook listening on port 3000");
  await refreshToken();
  setInterval(refreshToken, 60 * 60 * 1000); // refresh every hour

  // start cron jobs (10am reminder + 9pm summary)
  startCronJobs();
});
