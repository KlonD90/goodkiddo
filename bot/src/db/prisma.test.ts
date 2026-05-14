import { describe, expect, test } from "bun:test";
import { createPrismaClient, redactDatabaseUrl } from "./prisma";

describe("createPrismaClient", () => {
	test("creates a Prisma client for PostgreSQL URLs", async () => {
		const prisma = createPrismaClient("postgresql://user:pass@localhost:5432/db");
		expect(prisma).toBeDefined();
		await prisma.$disconnect();
	});
});

describe("redactDatabaseUrl", () => {
	test("redacts passwords", () => {
		expect(
			redactDatabaseUrl("postgresql://user:secret@localhost:5432/db"),
		).toBe("postgresql://user:****@localhost:5432/db");
	});

	test("handles invalid URLs", () => {
		expect(redactDatabaseUrl("not a url")).toBe("<invalid DATABASE_URL>");
	});
});
