import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

const prisma = new PrismaClient();

try {
  const contactsCount = await prisma.contact.count();
  const conversationsCount = await prisma.conversation.count();

  console.log("Prisma connected successfully.");
  console.log({ contactsCount, conversationsCount });
} finally {
  await prisma.$disconnect();
}
