/* =========================================================
    MY HOME (the first page an employee sees)
    Everything that is theirs, in one list, newest worry first:
      • chat tasks — a team-chat message that @tags them (internalTasks.js);
      • Call Log tasks assigned to them (callLog.js);
      • Internal Audit actions they own (findingsRoutes.js);
    plus chats with unread messages and what they finished in the last 7 days.
    Each item says which page opens it, so tapping it takes them inside.
========================================================= */
import { allTasks } from "./internalTasks.js";

const DAY = 24 * 60 * 60 * 1000;
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}` : value ? String(value).slice(0, 10) : null);
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const short = (text, length = 140) => { const clean = String(text || "").replace(/\s+/g, " ").trim(); return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean; };

export function registerMyHomeRoutes(app, { db, auth, getUserKey, canSeeChat }) {
  app.get("/me/home", auth, async (req, res) => {
    try {
      const me = getUserKey(req.user);
      const userId = req.user?.role === "admin" ? null : String(req.user?.userId || "");
      const now = Date.now();
      const today = todayIst();
      const work = [];
      let doneThisWeek = 0;

      // Chat tasks they are tagged in.
      const seeChat = (chatId) => {
        const chat = (global.internalChats || []).find((item) => String(item.id) === String(chatId));
        return chat && canSeeChat(chat, req.user);
      };
      for (const task of allTasks()) {
        if (!task.assignees.some((person) => person.key === me) || !seeChat(task.chatId)) continue;
        if (task.status === "resolved") {
          if (task.completedAt && now - new Date(task.completedAt).getTime() < 7 * DAY) doneThisWeek += 1;
          continue;
        }
        work.push({
          type: "task", id: task.id, title: short(task.text.replace(/@\S+/g, "").trim() || task.text), from: task.createdBy,
          where: task.chatTitle, status: task.status === "in-progress" ? "In progress" : "Open",
          due: task.dueAt, overdue: task.overdue, due_soon: task.dueSoon, urgent: task.priority === "urgent",
          at: task.createdAt, open: { view: "internal-chat", chatId: task.chatId, department: task.department },
        });
      }

      if (userId) {
        // Call Log tasks assigned to them.
        const calls = await db.query(
          `SELECT id, ref, title, details, location, priority, status, raised_by, due_at, created_at, done_at, done_by
           FROM call_logs WHERE assignee_id = $1 AND (status IN ('Open', 'In Progress') OR done_at > NOW() - INTERVAL '7 days')
           ORDER BY created_at DESC LIMIT 200`, [userId]
        ).catch(() => ({ rows: [] }));
        for (const call of calls.rows) {
          if (!["Open", "In Progress"].includes(call.status)) { if (call.status === "Done") doneThisWeek += 1; continue; }
          const due = call.due_at ? new Date(call.due_at) : null;
          work.push({
            type: "call", id: call.id, ref: call.ref, title: short(call.title), from: call.raised_by, where: call.location || null,
            status: call.status, due: due ? due.toISOString() : null, overdue: Boolean(due && due.getTime() < now),
            due_soon: Boolean(due && due.getTime() >= now && due.getTime() - now < 2 * 60 * 60 * 1000), urgent: ["High", "Urgent"].includes(call.priority),
            at: call.created_at, open: { view: "call-log", id: call.id },
          });
        }
        // Internal Audit actions they own.
        const findings = await db.query(
          `SELECT id, ref, department, title, description, risk, status, action_plan, due_date, created_by, created_at, follow_ups, locations, attachments
           FROM audit_findings WHERE assignee_id = $1 AND status <> 'Closed' ORDER BY due_date LIMIT 200`, [userId]
        ).catch(() => ({ rows: [] }));
        for (const finding of findings.rows) {
          const due = plainDate(finding.due_date);
          const last = Array.isArray(finding.follow_ups) && finding.follow_ups.length ? finding.follow_ups[finding.follow_ups.length - 1] : null;
          work.push({
            // The details and what to do (one box now; older findings also have a separate action plan).
            type: "audit", id: finding.id, ref: finding.ref, title: short(finding.title),
            action: short([finding.description, finding.action_plan && finding.action_plan !== finding.description ? `To do: ${finding.action_plan}` : ""].filter(Boolean).join(" · "), 400),
            from: finding.created_by, files: Array.isArray(finding.attachments) ? finding.attachments.length : 0,
            where: [finding.department, ...(finding.locations || [])].join(" · "), status: finding.status, risk: finding.risk, due, overdue: Boolean(due && due < today), due_soon: due === today,
            urgent: finding.risk === "Critical", last_note: last ? short(last.note || last.text || "", 100) : null,
            at: finding.created_at, open: { view: "findings", id: finding.id },
          });
        }
      }

      // Overdue first, then due soon, then by due date, then newest.
      const dueMs = (item) => (item.due ? new Date(item.due.length === 10 ? `${item.due}T23:59:00+05:30` : item.due).getTime() : Infinity);
      work.sort((a, b) => (b.overdue - a.overdue) || (b.due_soon - a.due_soon) || (b.urgent - a.urgent) || (dueMs(a) - dueMs(b)) || (new Date(b.at) - new Date(a.at)));

      // Chats with messages they haven't read.
      const chats = (global.internalChats || [])
        .filter((chat) => canSeeChat(chat, req.user) && !chat.archived && Number(chat.unreadBy?.[me] || 0) > 0)
        .map((chat) => {
          const last = (chat.messages || []).slice().reverse().find((message) => message.text || message.attachments?.length);
          // A direct chat is shown by the other person's name.
          const otherKey = chat.type === "direct" ? (chat.members || []).map(String).find((key) => key !== me) : null;
          const other = otherKey === "admin" ? "Admin" : otherKey ? (global.internalUsers || []).find((user) => String(user.id) === otherKey)?.name : null;
          return {
            id: chat.id, department: chat.department, direct: chat.type === "direct",
            title: chat.type === "direct" ? (other || "Direct chat") : chat.title || `${chat.department} chat`,
            unread: Number(chat.unreadBy[me]),
            last: last ? { sender: last.sender, text: short(last.text || `📎 ${last.attachments.length} attachment(s)`, 90), at: last.createdAt || new Date(Math.floor(Number(last.id)) || now).toISOString() } : null,
          };
        })
        .sort((a, b) => new Date(b.last?.at || 0) - new Date(a.last?.at || 0));

      res.json({
        today,
        work,
        counts: {
          open: work.length, overdue: work.filter((item) => item.overdue).length,
          today: work.filter((item) => item.due_soon || (item.due && item.due.slice(0, 10) === today)).length,
          unread: chats.reduce((sum, chat) => sum + chat.unread, 0), done_week: doneThisWeek,
        },
        chats: chats.slice(0, 8),
      });
    } catch (err) {
      console.log("MY HOME ERROR:", err.message);
      res.status(500).json({ error: "Could not load your home page" });
    }
  });
}
