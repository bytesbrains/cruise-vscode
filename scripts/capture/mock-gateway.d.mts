/** Types for `mock-gateway.mjs`, so `test/capture-mock.test.ts` typechecks against it. */
export interface MockGateway {
  /** `http://127.0.0.1:<port>`; deployments are `/production`, `/demo` and `/proxy` under it. */
  base: string;
  /** Every request, by deployment, route and key prefix, never the key. */
  seen: { deployment: "production" | "demo" | "proxy"; route: string; prefix: string }[];
  close(): Promise<void>;
}

export function startMockGateway(): Promise<MockGateway>;
