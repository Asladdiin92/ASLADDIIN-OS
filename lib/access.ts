import { auth, clerkClient } from "@clerk/nextjs/server";

const CACHE_TTL_MS = 5 * 60_000;
const userEmailLookups = new Map<string, { promise: Promise<string[]>; expiresAt: number }>();

export async function hasPlannerAccess(): Promise<boolean> {
  const { userId } = await auth();
  return userId ? hasPlannerUserAccess(userId) : false;
}

export async function hasPlannerUserAccess(userId: string): Promise<boolean> {
  const allowedEmails = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (allowedEmails.length === 0) return false;

  const cached = userEmailLookups.get(userId);
  let lookup: Promise<string[]>;
  if (cached && cached.expiresAt > Date.now()) {
    lookup = cached.promise;
  } else {
    const entry: { promise: Promise<string[]>; expiresAt: number } = {
      promise: Promise.resolve([]),
      expiresAt: Number.POSITIVE_INFINITY,
    };
    entry.promise = clerkClient()
      .then((client) => client.users.getUser(userId))
      .then((user) => user.emailAddresses
        .filter((address) => address.verification?.status === "verified")
        .map((address) => address.emailAddress.toLowerCase()))
      .then(
        (emails) => {
          if (userEmailLookups.get(userId) === entry) {
            entry.expiresAt = Date.now() + CACHE_TTL_MS;
          }
          return emails;
        },
        (error: unknown) => {
          if (userEmailLookups.get(userId) === entry) userEmailLookups.delete(userId);
          throw error;
        },
      );
    userEmailLookups.set(userId, entry);
    lookup = entry.promise;
  }
  const verifiedEmails = await lookup;
  return verifiedEmails.some((email) => allowedEmails.includes(email));
}
