import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { devices } from "@/data/site";
import {
  getTariffById,
  getTariffPeriodById,
  getTariffPrice,
} from "@/data/tariffs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LeadPayload = {
  name?: unknown;
  contact?: unknown;
  tariffId?: unknown;
  periodId?: unknown;
  device?: unknown;
  comment?: unknown;
};

type AcceptedLead = {
  leadId: string;
  name: string;
  contact: string;
  tariffId: string;
  tariffName: string;
  periodId: string;
  periodLabel: string;
  deviceCount: number;
  price: number;
  device: string;
  comment: string;
  createdAt: string;
};

type TelegramApiResponse = {
  ok?: boolean;
  result?: {
    message_id?: number;
  };
};

function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function generateLeadId() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");
  const randomCode = randomBytes(2).toString("hex").toUpperCase();

  return `DPN-${year}${month}${day}-${hours}${minutes}${seconds}-${randomCode}`;
}

function sanitizeInlineText(value: string, maxLength: number) {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeMultilineText(value: string, maxLength: number) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function buildTelegramMessage(lead: AcceptedLead) {
  const comment = sanitizeMultilineText(lead.comment, 1500) || "—";

  return [
    "Новая заявка DPN",
    "",
    `Тариф: ${sanitizeInlineText(lead.tariffName, 80)}`,
    `Срок: ${sanitizeInlineText(lead.periodLabel, 80)}`,
    `Сумма: ${lead.price} ₽`,
    `Устройств: ${lead.deviceCount}`,
    "",
    `Имя: ${sanitizeInlineText(lead.name, 160)}`,
    `Контакт: ${sanitizeInlineText(lead.contact, 240)}`,
    `Устройство: ${sanitizeInlineText(lead.device, 80)}`,
    `Комментарий: ${comment}`,
    "",
    "Источник: сайт",
  ].join("\n");
}

async function sendTelegramNotification(lead: AcceptedLead) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  const envPresent = Boolean(botToken && chatId);

  console.log(`telegram env present: ${envPresent}`);

  if (!botToken || !chatId) {
    console.warn(
      "telegram send skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured",
    );
    return "";
  }

  console.log("telegram send started");

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: buildTelegramMessage(lead),
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
    );

    const responseBody = await response.text();
    console.log(`telegram send response status: ${response.status}`);

    let telegramResult: TelegramApiResponse | null = null;
    try {
      telegramResult = JSON.parse(responseBody) as TelegramApiResponse;
    } catch {
      telegramResult = null;
    }

    if (!response.ok || !telegramResult?.ok) {
      console.error("telegram send failed:", {
        status: response.status,
        responseBody: responseBody.slice(0, 2000),
      });
      return "";
    }

    console.log("telegram send ok");
    return typeof telegramResult.result?.message_id === "number"
      ? String(telegramResult.result.message_id)
      : "";
  } catch {
    console.error("telegram send failed: network request failed");
    return "";
  }
}

async function sendGoogleSheetsWebhook(
  lead: AcceptedLead,
  telegramMessageId: string,
) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL?.trim();

  if (!webhookUrl) {
    console.warn("Google Sheets webhook URL is not configured");
    return;
  }

  console.log("google sheets webhook started");

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadId: lead.leadId,
        status: "Новая",
        tariff: lead.tariffName,
        period: lead.periodLabel,
        price: lead.price,
        devices: lead.deviceCount,
        name: lead.name,
        contact: lead.contact,
        device: lead.device,
        comment: lead.comment,
        source: "сайт",
        telegramMessageId,
      }),
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });

    console.log(`google sheets webhook response status: ${response.status}`);

    if (!response.ok) {
      console.error("Google Sheets webhook failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return;
    }

    console.log("google sheets webhook ok");
  } catch {
    console.error("Google Sheets webhook failed: network request failed");
  }
}

export async function POST(request: Request) {
  let body: LeadPayload;

  try {
    const parsedBody: unknown = await request.json();

    if (
      !parsedBody ||
      typeof parsedBody !== "object" ||
      Array.isArray(parsedBody)
    ) {
      throw new Error("Invalid body");
    }

    body = parsedBody as LeadPayload;
  } catch {
    return NextResponse.json(
      { success: false, error: "Некорректный формат данных." },
      { status: 400 },
    );
  }

  if (!isFilledString(body.name)) {
    return NextResponse.json(
      { success: false, error: "Укажите имя." },
      { status: 400 },
    );
  }

  if (!isFilledString(body.contact)) {
    return NextResponse.json(
      { success: false, error: "Укажите контакт для связи." },
      { status: 400 },
    );
  }

  const tariff = getTariffById(body.tariffId);
  if (!tariff) {
    return NextResponse.json(
      { success: false, error: "Выберите корректный тариф." },
      { status: 400 },
    );
  }

  const period = getTariffPeriodById(body.periodId);
  if (!period) {
    return NextResponse.json(
      { success: false, error: "Выберите корректный срок." },
      { status: 400 },
    );
  }

  if (
    !isFilledString(body.device) ||
    !devices.includes(body.device as (typeof devices)[number])
  ) {
    return NextResponse.json(
      { success: false, error: "Выберите корректное устройство." },
      { status: 400 },
    );
  }

  const price = getTariffPrice(tariff.id, period.id);
  if (price === undefined) {
    return NextResponse.json(
      { success: false, error: "Не удалось определить стоимость." },
      { status: 400 },
    );
  }

  const lead: AcceptedLead = {
    leadId: generateLeadId(),
    name: body.name.trim(),
    contact: body.contact.trim(),
    tariffId: tariff.id,
    tariffName: tariff.name,
    periodId: period.id,
    periodLabel: period.label,
    deviceCount: tariff.deviceCount,
    price,
    device: body.device.trim(),
    comment: typeof body.comment === "string" ? body.comment.trim() : "",
    createdAt: new Date().toISOString(),
  };

  console.log("lead received", {
    leadId: lead.leadId,
    tariffId: lead.tariffId,
    periodId: lead.periodId,
    device: lead.device,
    hasComment: lead.comment.length > 0,
  });

  const telegramMessageId = await sendTelegramNotification(lead);
  await sendGoogleSheetsWebhook(lead, telegramMessageId);

  return NextResponse.json({ success: true });
}
