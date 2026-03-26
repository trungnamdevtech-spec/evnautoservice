import { MongoClient, type Db } from "mongodb";
import { env } from "../config/env.js";

let client: MongoClient | null = null;

export async function getMongoDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(env.mongodbUri);
    await client.connect();
  }
  return client.db(env.mongodbDb);
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
