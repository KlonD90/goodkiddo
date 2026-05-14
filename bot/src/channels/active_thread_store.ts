import type { AppPrisma } from "../db/prisma";

export class ActiveThreadStore {
	private readonly prisma: AppPrisma;

	constructor(prisma: AppPrisma) {
		this.prisma = prisma;
	}

	async ready(): Promise<void> {
		return;
	}

	async getOrCreate(caller: string, defaultThreadId: string): Promise<string> {
		const existing = await this.prisma.activeThread.findUnique({
			where: { caller },
		});
		if (existing) return existing.activeThreadId;

		await this.setActiveThread(caller, defaultThreadId);
		return defaultThreadId;
	}

	async setActiveThread(caller: string, threadId: string): Promise<void> {
		const updatedAt = new Date().toISOString();
		await this.prisma.activeThread.upsert({
			where: { caller },
			update: { activeThreadId: threadId, updatedAt },
			create: { caller, activeThreadId: threadId, updatedAt },
		});
	}
}
