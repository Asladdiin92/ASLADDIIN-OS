import { auth, clerkClient } from "@clerk/nextjs/server";

const userEmailLookups = new Map<string, Promise<string[]>>();

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

  let lookup = userEmailLookups.get(userId);
  if (!lookup) {
    lookup = clerkClient()
      .then((client) => client.users.getUser(userId))
      .then((user) => user.emailAddresses
        .filter((address) => address.verification?.status === "verified")
        .map((address) => address.emailAddress.toLowerCase()))
      .finally(() => {
        if (userEmailLookups.get(userId) === lookup) userEmailLookups.delete(userId);
      });
    userEmailLookups.set(userId, lookup);
  }
  const verifiedEmails = await lookup;
  return verifiedEmails.some((email) => allowedEmails.includes(email));
}
