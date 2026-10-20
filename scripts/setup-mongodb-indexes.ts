import { closeMongoConnection } from "../lib/mongodb";
import { ensureMongoIndexes } from "../lib/mongodb-indexes";

async function main(): Promise<void> {
  try {
    await ensureMongoIndexes();
    console.info("MongoDB application indexes are ready.");
  } catch (error) {
    console.error("MongoDB index setup failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    process.exitCode = 1;
  } finally {
    await closeMongoConnection();
  }
}

void main();
