import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasPlannerAccess } from "@/lib/access";
import { getTelegramLink } from "@/lib/integration-store";
import { sendTelegramMessage } from "@/lib/telegram-bot";
import { plannerDateKey, todayInPlannerTimeZone } from "@/lib/planner-datetime";
import { fetchNotionTasks } from "@/lib/notion";
import { isSameOrigin } from "@/lib/task-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!await hasPlannerAccess()) {
    return NextResponse.json({ error: "You are not authorized to send a Telegram summary." }, { status: 403 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "This request must come from the dashboard." }, { status: 403 });
  }
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in before sending a Telegram summary." }, { status: 401 });
  if (!process.env.MONGO_URI || !process.env.TELEGRAM_BOT_TOKEN ||
      !process.env.TELEGRAM_WEBHOOK_SECRET || !process.env.TELEGRAM_BOT_USERNAME) {
    return NextResponse.json({ sent: false }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const link = await getTelegramLink(userId);
    if (!link) return NextResponse.json({ sent: false }, { headers: { "Cache-Control": "no-store" } });
    const tasks = await fetchNotionTasks();
    const today = todayInPlannerTimeZone();
    const overdue = tasks.filter((task) => {
      const deadline = task.dateEnd || task.dueDate;
      return !task.completed && Boolean(deadline) && plannerDateKey(deadline!) < today;
    }).length;
    const dueToday = tasks.filter((task) => {
      if (task.completed || !task.dueDate) return false;
      return plannerDateKey(task.dueDate) <= today && plannerDateKey(task.dateEnd || task.dueDate) >= today;
    }).length;
    const open = tasks.filter((task) => !task.completed).length;
    const message = [
      "ASLADDIIN OS planner refresh",
      `Open items: ${open}`,
      `Due today: ${dueToday}`,
      `Overdue: ${overdue}`,
      "",
      "Counts only. No task titles, notes, email, or calendar details were sent.",
    ].join("\n");
    await sendTelegramMessage(link.chatId, message);
    return NextResponse.json({ sent: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not send the Telegram planner summary.";
    return NextResponse.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
