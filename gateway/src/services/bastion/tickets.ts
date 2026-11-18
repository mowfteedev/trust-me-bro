import { generateSecureToken } from '../../utils/crypto.js';

interface BastionTicket {
  nodeId: string;
  userId: string;
  sessionVersion: number;
  expiresAt: number;
  authExpiresAt: number;
  authSessionId?: string;
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
  authExpiresAt = Date.now() + 86400000,
  authSessionId?: string
): string {
  const ticket = generateSecureToken(32);
  ticketStore.set(ticket, {
    nodeId,
    userId,
    sessionVersion,
    expiresAt: Date.now() + Math.max(1000, ttlSeconds * 1000),
    authExpiresAt,
    authSessionId,
  });
  return ticket;
}

export function verifyAndConsumeTicket(ticket: string, targetNodeId?: string): { valid: boolean; ticketData?: BastionTicket } {
  const ticketData = ticketStore.get(ticket);
  if (!ticketData) {
    return { valid: false };
  }

  // Consume first so a failed node/deadline check also burns the ticket.
  ticketStore.delete(ticket);

  if (ticketData.expiresAt <= Date.now() || ticketData.authExpiresAt <= Date.now()) {
    return { valid: false };
  }

  if (targetNodeId && ticketData.nodeId !== targetNodeId) {
    return { valid: false };
  }

  return { valid: true, ticketData };
}

export function invalidateTicketsForNode(nodeId: string): number {
  let count = 0;
  for (const [ticket, data] of ticketStore.entries()) {
    if (data.nodeId === nodeId) {
      ticketStore.delete(ticket);
      count++;
    }
  }
  return count;
}
