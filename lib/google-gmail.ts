export type GoogleMessageClassification = {
  category: string;
  reason: string;
};

const attentionPattern = /\b(action required|action needed|urgent|deadline|verify your account|review requested|approval required|response required|payment due)\b/i;
const possibleReplyPattern = /\b(please (?:reply|respond|confirm)|response requested|let me know|could you|can you|would you|reply by|respond by)\b/i;
const securityPattern = /\b(security|password|sign[- ]in|login|two[- ]factor|2fa|verification code|suspicious activity|new device)\b/i;
const academicPattern = /\b(university|college|campus|course|class|lecture|assignment|exam|grade|semester|academic)\b/i;
const developmentPattern = /\b(github|gitlab|vercel|npm|pull request|deployment|build failed|ci\/cd|commit|repository)\b/i;
const automatedPattern = /\b(no[- ]?reply|automated|notification|digest|newsletter|do not reply)\b/i;

export function sanitizeProviderText(value: string, maxLength = 500): string {
  const sanitized = (typeof value === "string" ? value : "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|quot|apos|lt|gt|nbsp);/gi, (entity) => ({
      "&amp;": "&",
      "&quot;": "\"",
      "&apos;": "'",
      "&lt;": "<",
      "&gt;": ">",
      "&nbsp;": " ",
    })[entity.toLowerCase()] ?? " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (sanitized.length <= maxLength) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function sanitizeGmailSnippet(value: string, maxLength = 180): string {
  return sanitizeProviderText(value, maxLength);
}

export function maskGoogleEmail(email: string | undefined): string {
  if (!email) return "Unavailable";
  const [localPart, domain, ...extra] = email.split("@");
  if (!localPart || !domain || extra.length > 0) return "Google account";
  return `${localPart.slice(0, Math.min(4, localPart.length))}****@${domain}`;
}

export function classifyGoogleMessage(message: {
  from: string;
  subject: string;
  snippet: string;
}): GoogleMessageClassification[] {
  const content = `${message.from} ${message.subject} ${message.snippet}`;
  const categories: GoogleMessageClassification[] = [];
  const add = (category: string, reason: string) => categories.push({ category, reason });

  if (attentionPattern.test(`${message.subject} ${message.snippet}`)) {
    add("Needs attention", "Subject or snippet contains explicit action wording.");
  }
  const replyMatch = `${message.subject} ${message.snippet}`.match(possibleReplyPattern);
  if (replyMatch) {
    add("Possible reply", `Explicit request wording matched: “${replyMatch[0]}”. This is a suggestion, not a reply requirement.`);
  }
  if (securityPattern.test(content)) {
    add("Security", "Sender, subject, or snippet contains security-related wording.");
  }
  if (/\.edu(?:\b|$)/i.test(message.from) || academicPattern.test(content)) {
    add("Academic", "Sender domain or message text matches common academic terms.");
  }
  if (developmentPattern.test(content)) {
    add("Development tools", "Sender, subject, or snippet matches a development-tool term.");
  }
  if (automatedPattern.test(message.from) || automatedPattern.test(message.subject)) {
    add("Automated notifications", "Sender or subject indicates automated mail.");
  }

  if (categories.length === 0) {
    return [{ category: "Uncategorized", reason: "No local classification rule matched." }];
  }

  return categories;
}

export function formatGmailReceivedTime(value: string, now = Date.now()): {
  relative: string;
  absolute: string;
} {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return { relative: "Time unavailable", absolute: "Received time unavailable" };
  }

  const seconds = Math.round((date.getTime() - now) / 1000);
  const magnitude = Math.abs(seconds);
  const [unit, divisor] = magnitude < 60
    ? ["second", 1]
    : magnitude < 3600
      ? ["minute", 60]
      : magnitude < 86_400
        ? ["hour", 3600]
        : ["day", 86_400];
  const relative = magnitude < 30
    ? "just now"
    : new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
      Math.round(seconds / divisor),
      unit as Intl.RelativeTimeFormatUnit,
    );

  return {
    relative,
    absolute: new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  };
}
