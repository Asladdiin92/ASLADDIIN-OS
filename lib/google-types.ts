export type GoogleWorkspaceSummary = {
  connected: boolean;
  email?: string;
  unreadEmails: number;
  messages: Array<{ id: string; from: string; subject: string; date: string; snippet: string; body?: string }>;
  events: Array<{ id: string; title: string; start: string; end: string; link?: string }>;
  files: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; link?: string }>;
  errors?: Partial<Record<"gmail" | "calendar" | "drive", string>>;
};
