/** Seller adapter contract (KITE-AND-PROVIDERS.md): quote, execute,
 * inspect status, refund/cancel only where documented. */
export interface ProviderAdapter {
  key: string;
  merchant: string;
  rail: string;
  asset: string;
  capabilities: {
    quote: boolean;
    execute: boolean;
    status_lookup: boolean;
    refund: boolean;
  };
  /** Execute a charge for a broker action id. Resolves on a definitive
   * outcome; throws AmbiguousError when the result is unknown. */
  execute(req: {
    action_id: string;
    amount_minor: number;
    merchant: string;
    session_ref?: string;
  }): Promise<{ outcome: 'confirmed' | 'failed'; provider_ref?: string; reason?: string }>;
  /** Status lookup by broker action id — the reconciliation mechanism. */
  status(action_id: string): Promise<
    | { known: true; status: 'confirmed' | 'failed'; provider_ref?: string }
    | { known: false }
  >;
}

/** Thrown when the provider outcome cannot be established. */
export class AmbiguousError extends Error {
  constructor(msg: string) { super(msg); this.name = 'AmbiguousError'; }
}
