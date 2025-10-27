import cron from "node-cron";
import fetch from "node-fetch";
import { db } from "./firebaseConfig.js";

// === CONFIG ===
const GROUP_CHAT_ID = "oc_f74b662e4339aa17fc42b0628d5ac9a8";

// ye token index.js me refresh hota hai. hum is file me setter rakhenge.
let LARK_BOT_TOKEN = "";
export function setLarkToken(newToken) {
  LARK_BOT_TOKEN = newToken;
}

// helper: get today date string like 2025-10-26
function todayDate() {
  const d = new Date();
  const year = d.getFullYear();
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${mon}-${day}`;
}

// helper: get yesterday date string
function yesterdayDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const year = d.getFullYear();
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${mon}-${day}`;
}

// ======================
// SAVE REPORT WHEN USER SENDS IT
// Called from index.js after validation
// ======================
export async function saveUserReport({
  username,
  userId,
  date,
  summary,
  pending,
  reason,
  gitPush,
}) {
  const dayKey = date || todayDate();

  // 1. Save under /reports/<date>/<userId>/
  await db
    .collection("reports")
    .doc(dayKey)
    .collection("users")
    .doc(userId)
    .set(
      {
        username,
        date: dayKey,
        summary,
        pending,
        reason,
        gitPush,
        status: pending && pending.toLowerCase() !== "none" ? "pending" : "complete",
        createdAt: new Date(),
      },
      { merge: true }
    );

  // 2. If pending work is there, update pending_tasks/<userId>
  if (pending && pending.toLowerCase() !== "none") {
    await db.collection("pending_tasks").doc(userId).set(
      {
        username,
        task: pending,
        reason,
        last_date_reported: dayKey,
        status: "pending",
        remindedToday: false,
      },
      { merge: true }
    );
  } else {
    // if user says "none", mark his pending_tasks as completed
    await db.collection("pending_tasks").doc(userId).set(
      {
        status: "completed",
        completedAt: new Date(),
      },
      { merge: true }
    );
  }
}

// ======================
// CRON JOB 1: MORNING REMINDER (10:00 AM)
// ======================
async function sendPendingReminders() {
  console.log("⏰ Morning reminder job running...");

  // 1. Get all docs from pending_tasks where status == "pending"
  const snap = await db
    .collection("pending_tasks")
    .where("status", "==", "pending")
    .get();

  if (snap.empty) {
    console.log("✅ No pending tasks to remind.");
    return;
  }

  // 2. Build message for group
  let textMsg = "☀️ Good morning team!\nThese tasks are still pending from yesterday:\n\n";

  snap.forEach((doc) => {
    const data = doc.data();
    textMsg += `• ${data.username}: "${data.task}" (reason: ${data.reason || "N/A"})\n`;
  });

  textMsg += `\nPlease complete these before tonight's report ✅`;

  // 3. Send to Lark group chat
  await sendGroupMessage(textMsg);

  // 4. Mark remindedToday = true so we don't spam same people every morning
  const batch = db.batch();
  snap.forEach((doc) => {
    const ref = db.collection("pending_tasks").doc(doc.id);
    batch.set(
      ref,
      {
        remindedToday: true,
        lastReminderAt: new Date(),
      },
      { merge: true }
    );
  });
  await batch.commit();

  console.log("📤 Morning reminder sent.");
}

// ======================
// CRON JOB 2: NIGHT CHECK (9:00 PM)
// ======================
async function checkDailyReports() {
  console.log("🌙 Night check job running...");

  const dayKey = todayDate();

  // 1. Get all users who actually submitted today
  const submittedSnap = await db
    .collection("reports")
    .doc(dayKey)
    .collection("users")
    .get();

  const submittedIds = [];
  const submittedNames = [];

  submittedSnap.forEach((doc) => {
    const data = doc.data();
    submittedIds.push(doc.id);
    submittedNames.push(data.username || doc.id);
  });

  // TODO (simple version): You maintain a fixed team list here.
  // Later we can auto-load group members using Lark API im/chat info
  const teamMembers = [
    { id: "arslan_id", name: "Muhammad Arslan" },
    { id: "zeeshan_id", name: "Zeeshan" },
    { id: "hajra_id", name: "Hajra" },
  ];

  // 2. Check who is missing
  const missing = teamMembers.filter((m) => !submittedIds.includes(m.id));

  // 3. Build message
  let msgText = `📅 Daily Report Check (${dayKey})\n\n`;

  if (missing.length === 0) {
    msgText += `✅ All members submitted report. Nice work team 👏\n`;
  } else {
    msgText += `⚠️ Missing reports:\n`;
    missing.forEach((m) => {
      msgText += `• ${m.name} please submit your report.\n`;
    });
  }

  // 4. Also include carry-forward info:
  //    Who is still pending from yesterday?
  const yKey = yesterdayDate();
  const ySnap = await db
    .collection("reports")
    .doc(yKey)
    .collection("users")
    .get();

  let carryForwardText = "";
  ySnap.forEach((doc) => {
    const data = doc.data();
    if (data.status === "pending") {
      carryForwardText += `• ${data.username}: yesterday pending "${data.pending}"\n`;
    }
  });

  if (carryForwardText) {
    msgText += `\n⏳ Still pending from yesterday:\n${carryForwardText}\nPlease close this today.`;
  }

  // 5. Send report summary to group
  await sendGroupMessage(msgText);

  console.log("📤 Night summary sent.");
}

// ======================
// Helper: send message to group in Lark
// ======================
async function sendGroupMessage(textMsg) {
  if (!LARK_BOT_TOKEN) {
    console.error("❌ No LARK_BOT_TOKEN available to send group message");
    return;
  }

  const payload = {
    receive_id_type: "chat_id",
    receive_id: GROUP_CHAT_ID,
    msg_type: "text",
    content: JSON.stringify({ text: textMsg }),
  };

  const res = await fetch(
    "https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LARK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await res.json();
  console.log("📤 sendGroupMessage() response:", data);
}

// ======================
// START CRON JOBS
// ======================
export function startCronJobs() {
  // 10:00 AM every day
  cron.schedule("0 10 * * *", async () => {
    await sendPendingReminders();
  });

  // 9:00 PM every day
  cron.schedule("0 21 * * *", async () => {
    await checkDailyReports();
  });

  console.log("⏰ Cron jobs scheduled: 10AM reminder + 9PM summary");
}
