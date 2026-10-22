import "server-only";

import { MongoClient, type Db } from "mongodb";
import { aiMongoDatabaseName, mongoDatabaseName, validateMongoEnvironment } from "@/lib/mongo-config";

export type MongoHealthStatus = "connected" | "disconnected" | "error";

type MongoGlobal = typeof globalThis & {
  asladinMongoClientPromise?: Promise<MongoClient>;
  asladinMongoHealthStatus?: MongoHealthStatus;
};

const mongoGlobal = globalThis as MongoGlobal;

export async function getMongoClient(): Promise<MongoClient> {
  validateMongoEnvironment();
  const uri = process.env.MONGO_URI?.trim();
  if (!uri) {
    mongoGlobal.asladinMongoHealthStatus = "disconnected";
    throw new Error("MongoDB is not configured. Set MONGO_URI.");
  }
  if (!mongoGlobal.asladinMongoClientPromise) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      maxPoolSize: 5,
    });
    mongoGlobal.asladinMongoClientPromise = client.connect().then((connectedClient) => {
      mongoGlobal.asladinMongoHealthStatus = "connected";
      return connectedClient;
    }).catch(() => {
      mongoGlobal.asladinMongoClientPromise = undefined;
      mongoGlobal.asladinMongoHealthStatus = "error";
      throw new Error("MongoDB connection failed. Check the server configuration and Atlas network access.");
    });
  }
  return mongoGlobal.asladinMongoClientPromise;
}

export async function getMongoDb(): Promise<Db> {
  const name = mongoDatabaseName();
  if (!name) throw new Error("MongoDB is not configured. Set MONGO_DB_NAME for integration storage.");
  const client = await getMongoClient();
  return client.db(name);
}

export async function getAIDatabase(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(aiMongoDatabaseName());
}

export async function getMongoHealthStatus(): Promise<MongoHealthStatus> {
  try {
    if (!process.env.MONGO_URI?.trim()) return "disconnected";
    const client = await getMongoClient();
    await client.db(aiMongoDatabaseName()).command({ ping: 1 });
    mongoGlobal.asladinMongoHealthStatus = "connected";
    return "connected";
  } catch {
    const configured = Boolean(process.env.MONGO_URI?.trim());
    mongoGlobal.asladinMongoHealthStatus = configured ? "error" : "disconnected";
    return mongoGlobal.asladinMongoHealthStatus;
  }
}

export async function closeMongoConnection(): Promise<void> {
  const clientPromise = mongoGlobal.asladinMongoClientPromise;
  if (!clientPromise) {
    mongoGlobal.asladinMongoHealthStatus = "disconnected";
    return;
  }
  try {
    const client = await clientPromise;
    await client.close();
  } finally {
    mongoGlobal.asladinMongoClientPromise = undefined;
    mongoGlobal.asladinMongoHealthStatus = "disconnected";
  }
}
