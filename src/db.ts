import { PrismaClient } from "@prisma/client";

// Prisma schema uses `directUrl`; local Postgres often only needs DATABASE_URL.
if (process.env.DATABASE_URL && !process.env.DIRECT_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
}

export const prisma = new PrismaClient();

