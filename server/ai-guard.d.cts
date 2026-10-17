export interface Policy { scope: string; prefix?: string; perMinute: number; perDay: number; concurrent: number; maxBodyBytes: number; paid?: boolean; validate?: (body: Record<string, unknown>, req: Request) => void; select?: (body: Record<string, unknown>) => Policy; }
export class GuardError extends Error { status: number; code: string; retryAfter: number; constructor(status: number, code: string, message: string, retryAfter?: number); }
export function integerEnv(name: string, fallback: number, min?: number, max?: number): number;
export function textField(body: Record<string, unknown>, name: string, max: number, required?: boolean): void;
export function imageField(body: Record<string, unknown>, name: string, required?: boolean): void;
export function enumField(body: Record<string, unknown>, name: string, allowed: unknown[]): void;
export function withWebGuard(req: Request, policy: Policy, handler: (req: Request) => Promise<Response>): Promise<Response>;
export function bufferedFetch(url: string | URL, init?: RequestInit, options?: {maxBytes?: number; timeoutMs?: number}): Promise<Response>;
