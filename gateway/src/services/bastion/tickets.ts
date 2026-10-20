import { generateSecureToken } from '../../utils/crypto.js';

interface BastionTicket {
  nodeId: string;
  userId: string;
  sessionVersion: number;
  expiresAt: number;
  authExpiresAt: number;
}

const ticketStore = new Map<string, BastionTicket>();

let ticketCleanerInterval: NodeJS.Timeout | null = null;

export function startTicketCleaner(): void {
  if (ticketCleanerInterval) return;
  ticketCleanerInterval = setInterval(() => {
    const now = Date.now();
    for (const [ticket, data] of ticketStore.entries()) {
      if (data.expiresAt < now) ticketStore.delete(ticket);
    }
  }, 10000);
  ticketCleanerInterval.unref();
}

export function stopTicketCleaner(): void {
  if (ticketCleanerInterval) clearInterval(ticketCleanerInterval);
  ticketCleanerInterval = null;
}

export function createBastionTicket(
  nodeId: string,
  userId: string,
  sessionVersion: number,
  ttlSeconds = 30,
  authExpiresAt = Date.now() + 86400000
): string {
  const ticket = generateSecureToken(32);
  ticketStore.set(ticket, {
    nodeId,
    userId,
    sessionVersion,
    expiresAt: Date.now() + Math.max(1000, ttlSeconds * 1000),
    authExpiresAt,
  });
  return ticket;
}

export function verifyAndConsumeTicket(ticket: string, nodeId: string): { valid: boolean; ticketData?: BastionTicket } {
  const ticketData = ticketStore.get(ticket);
  if (!ticketData) {
    return { valid: false };
  }

  // Consume first so a failed node/deadline check also burns the ticket.
  ticketStore.delete(ticket);

  if (ticketData.expiresAt <= Date.now() || ticketData.authExpiresAt <= Date.now()) {
    return { valid: false };
  }

  if (ticketData.nodeId !== nodeId) {
    return { valid: false };
  }

  return { valid: true, ticketData };
}
