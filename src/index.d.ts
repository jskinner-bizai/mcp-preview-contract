export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Preview { token: string; plan: Json[] }
export type Decoded =
  | { kind: 'preview'; preview: Preview }
  | { kind: 'committed'; plan: Json[] }
  | { kind: 'rejected'; preview?: Preview };
export interface Observation { state: Json; writes: number }
export interface Fixture {
  /** Declarative guard only. Factories must actually isolate disposable state. */
  disposable: true;
  client: {
    listTools(params?: { cursor?: string }): Promise<{ tools: { name: string }[]; nextCursor?: string }>;
    callTool(params: { name: string; arguments: Record<string, Json> }): Promise<unknown>;
  };
  profile: {
    toolName: string;
    previewArguments(): Record<string, Json>;
    commitArguments(token?: string): Record<string, Json>;
    /** Return a schema-valid unissued token, distinct from the reviewed token. */
    invalidToken(reviewedToken: string): string;
    otherScopeArguments(token: string): Record<string, Json>;
    decode(result: unknown): Decoded;
  };
  observer: {
    /** Independent backing-state snapshot and monotonic mutation journal count. */
    snapshot(): Promise<Observation>;
    /** Deliberately change relevant fixture state between preview and confirmation. */
    change(): Promise<void>;
  };
  expected: {
    initial: Json;
    plan: Json[];
    afterCommit: Json;
    changed: Json;
    changedPlan: Json[];
    afterReconfirm: Json;
    /** Number of independent mutation-journal entries for the approved commit. */
    commitWrites: number;
    reconfirmWrites: number;
  };
  close(): Promise<void>;
}
export interface CheckReceipt {
  name: string;
  passed: boolean;
  code: string;
  calls: { phase: string; outcome: string; argumentsSha256: string }[];
  observations: { phase: string; stateSha256: string; writes: number }[];
  beforeStateSha256?: string;
  afterStateSha256?: string;
  mutationDelta?: number;
  finalObservationChanged?: boolean;
  cleanup: 'closed' | 'failed' | 'not-created' | 'pending-factory';
}
export interface ContractReceipt {
  profile: 'preview-confirm-v1';
  name: string;
  passed: boolean;
  checkCount: number;
  passedCount: number;
  checks: CheckReceipt[];
  scope: string;
}
export function runPreviewContract(options: {
  name: string;
  createFixture(): Promise<Fixture>;
  timeoutMs?: number;
}): Promise<ContractReceipt>;
export type OnceResult =
  | { kind: 'result' | 'tool-error'; result: unknown; attempts: 1 }
  | { kind: 'protocol-error' | 'unknown'; attempts: 1; code: string };
export function callOnce(call: () => Promise<unknown>, options?: { timeoutMs?: number }): Promise<OnceResult>;
export function canonicalJson(value: Json): string;
export function stateHash(value: Json): string;
